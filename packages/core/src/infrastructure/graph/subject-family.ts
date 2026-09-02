import type { Driver } from 'neo4j-driver';

import { currentOnly, supersedeInTransaction, type SupersedeResult } from './bitemporal.js';
import { normalizeCognitiveText, TEXT_NORM_PROPERTY } from './cognitive-text.js';
import { inWriteTransaction, runRead, type GraphTransaction } from './connection.js';
import {
  DESCRIPTION_MENTION_COUNT_PROPERTY,
  DESCRIPTION_RETIRED_AT_PROPERTY,
  PRIOR_DESCRIPTIONS_PROPERTY,
} from './entity-description-queries.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, EXTRACTION_TYPE } from './labels.js';
import { ENTITY_NAME_NORM_PROPERTY, ENTITY_NAME_PROPERTY } from './seed-queries.js';
import { FACT_NODE_LABELS, MIN_SUBJECT_NAME_LENGTH } from './supersession-queries.js';
import { toGraphDateTime, toGraphInteger, type Row } from './values.js';
import { asCosine } from './vector-indexes.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
  keyedMismatchExcludes,
  type KeyedCloseMode,
} from '../../reflection/domain/claim-key.js';

/**
 * The middle blade between closing one claim and closing a whole observation.
 *
 * Closing the judged claim alone leaves its siblings from the same observation answering as
 * current, which is how an applied correction measured no change in what recall returned.
 * Closing the whole source episode also closes definitions and historical records that the
 * correction says nothing about: measured over twenty small two-observation episodes it took
 * 43 nodes, 2.1 per apply, and a real multi-turn session carries far more.
 *
 * A subject family is the third answer: the siblings extracted from the same observation that
 * name the same subject the judged claim named. A definition of a neighbouring term and a
 * record of a benchmark stay open, because neither names the subject whose value changed.
 *
 * Entities are never closed here or anywhere else: they hang off `MENTIONS` rather than
 * `EXTRACTED_FROM`, one entity outlives every episode that named it, and closing one would
 * take the identity every later mention resolves through. Their frozen descriptions are a
 * different matter, and they are why the measured correction changed nothing: the gloss
 * written by the first episode to name a subject was still stating the old owner at rank 1,
 * marked current, after the judged claim closed. A gloss that restates the relation the
 * correction just closed is retired rather than closed, which leaves the entity, its name and
 * its edges exactly where they were and stops it answering with a sentence that is no longer
 * true. The description comes back when something re-derives it from the claims that are open
 * now.
 */

/** Appendix B provenance, distinct from an episode-wide propagation so lineage stays readable. */
export const SUBJECT_PROPAGATION_METHOD = 'supersession_subject_propagation';

const SUBJECT_PROPAGATION_SIGNALS = ['subject_family'];

/**
 * The subjects a claim names: entities its own source episode mentioned whose stored fold
 * appears inside the claim's stored fold. The same test the detection leg uses to decide two
 * statements are about one thing, applied to one statement.
 */
const SUBJECTS_OF_CLAIM = [
  `MATCH (claim:${BASE_NODE_LABEL} { id: $claimId })-[:${EXTRACTION_TYPE}]->(source:Episode)`,
  `WHERE ${currentOnly('source')}`,
  `MATCH (source)-[:${ENTITY_MENTION_TYPE}]->(e:Entity)`,
  `WHERE ${currentOnly('e')}`,
  `  AND size(e.${ENTITY_NAME_NORM_PROPERTY}) >= $minNameLength`,
  `  AND claim.${TEXT_NORM_PROPERTY} CONTAINS e.${ENTITY_NAME_NORM_PROPERTY}`,
  `RETURN DISTINCT e.id AS id, e.${ENTITY_NAME_PROPERTY} AS name,`,
  `       e.${ENTITY_NAME_NORM_PROPERTY} AS name_norm, e.${MEMORY_PROPERTIES.text} AS text,`,
  '       source.id AS source_episode_id',
  'ORDER BY name_norm, id',
].join('\n');

export type ClaimSubject = {
  readonly entityId: string;
  readonly name: string;
  readonly nameNorm: string;
  /** The frozen description, when the entity carries one; this is what a close cannot reach. */
  readonly gloss?: string;
  readonly sourceEpisodeId: string;
};

function mapSubject(row: Row): ClaimSubject {
  const gloss = ((row.text as string | null) ?? '').trim();
  return {
    entityId: row.id as string,
    name: (row.name as string | null) ?? '',
    nameNorm: (row.name_norm as string | null) ?? '',
    sourceEpisodeId: row.source_episode_id as string,
    ...(gloss.length === 0 ? {} : { gloss }),
  };
}

/** `[]` when the claim was never extracted, its source is closed, or it names no entity. */
export async function findClaimSubjects(
  driver: Driver,
  claimId: string,
): Promise<readonly ClaimSubject[]> {
  return runRead(
    driver,
    SUBJECTS_OF_CLAIM,
    { claimId, minNameLength: toGraphInteger(MIN_SUBJECT_NAME_LENGTH) },
    mapSubject,
  );
}

const NAMES_A_SUBJECT = `head([name IN names WHERE sibling.${TEXT_NORM_PROPERTY} CONTAINS name]) IS NOT NULL`;

/**
 * Whether the key is available to decide this pair. Both sides have to carry a whole key for it
 * to be: a comparison needs two of them, and a claim that declined its key has nothing a keyed
 * sibling could be equal to.
 */
const BOTH_KEYED = [
  `claim.${CLAIM_SUBJECT_PROPERTY} IS NOT NULL AND claim.${CLAIM_ASPECT_PROPERTY} IS NOT NULL`,
  `AND sibling.${CLAIM_SUBJECT_PROPERTY} IS NOT NULL AND sibling.${CLAIM_ASPECT_PROPERTY} IS NOT NULL`,
].join('\n            ');

/** Two whole keys that agree: the same attribute of the same entity, stated twice. */
const KEYS_AGREE = [
  BOTH_KEYED,
  `AND sibling.${CLAIM_SUBJECT_PROPERTY} = claim.${CLAIM_SUBJECT_PROPERTY}`,
  `AND sibling.${CLAIM_ASPECT_PROPERTY} = claim.${CLAIM_ASPECT_PROPERTY}`,
].join('\n            ');

/**
 * The siblings a close is decided over. Same source episode, still open, naming one of the
 * claim's subjects, and observed nowhere else: a fact a second open episode also produced is
 * a fact the substrate saw twice, and one correction is not evidence against both.
 *
 * Naming the subject is where the match stops and where the decision starts. Two claims from
 * one observation about one subject can be about entirely different things: a correction that
 * moves a service's checkpoint store from one system to another says nothing about who was
 * assigned to do the work, and closing that second claim because it also said the service's
 * name takes a fact that is still true. `relatedness` is what separates them, and it is the
 * cosine between the two claims' own content vectors: the substrate's sanctioned statement
 * that two sentences are about the same thing, already computed, and re-derivable months later
 * by anyone who asks why a claim closed.
 *
 * Two keys that agree admit the sibling on their own, under every mode. Naming the subject was
 * always a stand-in for asserting about it, and an exact key match says the sibling states the
 * same attribute of the same entity, which is what the name was standing in for.
 *
 * Two keys that disagree are read as evidence of different attributes only under the `close`
 * mode. Extraction keys both halves of a correction rarely and the aspect slug drifts between
 * observations, so a mismatch is not yet a reliable answer, and excluding a sibling on it holds
 * a stale claim open as current. Under every other mode a mismatch falls through to the name
 * test, exactly as a pair with no key does. The relatedness floor still decides the close in
 * every case.
 */
const SUBJECT_SIBLINGS = [
  `MATCH (claim:${BASE_NODE_LABEL} { id: $claimId })-[:${EXTRACTION_TYPE}]->(source:Episode)`,
  `WHERE ${currentOnly('source')}`,
  // Optional, because a claim that carries a key names its subject through the key rather than
  // by spelling it. Without an entity to match, `names` is empty and the name test answers
  // false for every sibling, which is what it answered before a key existed.
  `OPTIONAL MATCH (source)-[:${ENTITY_MENTION_TYPE}]->(e:Entity)`,
  `WHERE ${currentOnly('e')}`,
  `  AND size(e.${ENTITY_NAME_NORM_PROPERTY}) >= $minNameLength`,
  `  AND claim.${TEXT_NORM_PROPERTY} CONTAINS e.${ENTITY_NAME_NORM_PROPERTY}`,
  // `claim` is carried through: the relatedness reading below is against its own vector.
  `WITH claim, source, collect(DISTINCT e.${ENTITY_NAME_NORM_PROPERTY}) AS names`,
  `MATCH (sibling)-[:${EXTRACTION_TYPE}]->(source)`,
  'WHERE sibling.id <> $claimId',
  '  AND any(label IN labels(sibling) WHERE label IN $labels)',
  `  AND ${currentOnly('sibling')}`,
  `  AND CASE WHEN ${KEYS_AGREE} THEN true`,
  `           WHEN $keyedMismatchExcludes AND ${BOTH_KEYED} THEN false`,
  `           ELSE ${NAMES_A_SUBJECT} END`,
  '  AND NOT EXISTS {',
  `    MATCH (sibling)-[:${EXTRACTION_TYPE}]->(other:Episode)`,
  `    WHERE other.id <> source.id AND ${currentOnly('other')}`,
  '  }',
  `RETURN sibling.id AS id, sibling.${MEMORY_PROPERTIES.text} AS text,`,
  '       [label IN labels(sibling) WHERE label IN $labels][0] AS label,',
  `       head([name IN names WHERE sibling.${TEXT_NORM_PROPERTY} CONTAINS name]) AS subject,`,
  `       (${KEYS_AGREE}) AS keyed,`,
  `       CASE WHEN claim.${MEMORY_PROPERTIES.contentVector} IS NULL`,
  `             OR sibling.${MEMORY_PROPERTIES.contentVector} IS NULL THEN null`,
  `            ELSE ${asCosine(
    `vector.similarity.cosine(claim.${MEMORY_PROPERTIES.contentVector}, sibling.${MEMORY_PROPERTIES.contentVector})`,
  )} END AS relatedness`,
  'ORDER BY id',
].join('\n');

export type SubjectSibling = {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  /** Which of the claim's subjects this sibling names, empty when the key matched it instead. */
  readonly subject: string;
  /** True when both claims carried a key and the two keys agreed, so no name was compared. */
  readonly keyed: boolean;
  /**
   * Cosine against the judged claim, or absent when either side has no content vector yet.
   * Absent is not zero and not one: it is "no answer", and a close is not made on no answer.
   */
  readonly relatedness?: number;
};

function mapSibling(row: Row): SubjectSibling {
  const { relatedness } = row;
  return {
    id: row.id as string,
    label: (row.label as string | null) ?? '',
    text: (row.text as string | null) ?? '',
    subject: (row.subject as string | null) ?? '',
    keyed: row.keyed === true,
    ...(typeof relatedness === 'number' ? { relatedness } : {}),
  };
}

/**
 * Whether the correction is evidence against this sibling as well as against the claim.
 *
 * A sibling with no relatedness reading stands. Under-closing leaves the old sentence beside
 * the new one in a pack, which is visible and reversible with `--episode`; over-closing takes
 * a true claim out of every future answer, which is neither. When the reading is missing
 * because a vector has not been written yet, the next apply on the same claim will have it.
 */
export function siblingCloses(sibling: SubjectSibling, floor: number): boolean {
  return sibling.relatedness !== undefined && sibling.relatedness >= floor;
}

function siblingParameters(
  claimId: string,
  keyedCloseMode: KeyedCloseMode | undefined,
): Record<string, unknown> {
  return {
    claimId,
    labels: [...FACT_NODE_LABELS],
    minNameLength: toGraphInteger(MIN_SUBJECT_NAME_LENGTH),
    keyedMismatchExcludes: keyedMismatchExcludes(keyedCloseMode),
  };
}

/**
 * The description and its embedding go together: a vector of a sentence the node no longer
 * states would keep pulling it up the ranking for a question it can no longer answer. With no
 * text the node is neither a pending vector nor a parity gap, since both populations are
 * defined on nodes that have text to embed.
 *
 * The wording moves to `prior_descriptions` on the way out, exactly as the refresh path moves
 * it. Nothing in this substrate is hard-deleted, and a retirement that dropped the only copy
 * of a sentence would be the one place that stopped being true.
 *
 * The mention baseline resets with it. Description freshness re-derives a description once an
 * entity has gained enough mentions since the last one was written, and leaving the old count
 * in place would hold a retired entity under that bar for as long as the count it was measured
 * against: the description would never come back.
 */
const RETIRE_GLOSS = [
  'MATCH (e:Entity { id: $id })',
  `WHERE e.${MEMORY_PROPERTIES.text} IS NOT NULL`,
  `SET e.${PRIOR_DESCRIPTIONS_PROPERTY} =`,
  `      coalesce(e.${PRIOR_DESCRIPTIONS_PROPERTY}, []) + [e.${MEMORY_PROPERTIES.text}],`,
  `    e.${MEMORY_PROPERTIES.text} = null,`,
  `    e.${MEMORY_PROPERTIES.contentVector} = null,`,
  `    e.${MEMORY_PROPERTIES.contentVectorHash} = null,`,
  `    e.${DESCRIPTION_MENTION_COUNT_PROPERTY} = 0,`,
  `    e.${DESCRIPTION_RETIRED_AT_PROPERTY} = $now`,
  'RETURN e.id AS id',
].join('\n');

/**
 * A gloss carries the description written for the entity plus the entity's own name, so a
 * subject whose name sits inside this one's is no evidence of anything: "Quillon" appears in
 * the gloss of "Quillon ingest pipeline" whatever that gloss goes on to say.
 */
function namesAnother(subject: ClaimSubject, other: ClaimSubject, folded: string): boolean {
  if (other.entityId === subject.entityId) {
    return false;
  }
  if (subject.nameNorm.includes(other.nameNorm)) {
    return false;
  }
  return folded.includes(other.nameNorm);
}

/**
 * A gloss is retired when it names another subject of the judged claim: a description that
 * repeats a relation between two entities the correction just closed a claim about was written
 * from that same claim. A gloss naming no other subject is a definition, and a definition
 * survives a correction about who owns the thing it defines.
 *
 * A single-subject claim retires nothing, since there is no second name for a gloss to carry.
 */
function glossRestatesClaim(subject: ClaimSubject, subjects: readonly ClaimSubject[]): boolean {
  if (subject.gloss === undefined) {
    return false;
  }
  const folded = normalizeCognitiveText(subject.gloss);
  return subjects.some((other) => namesAnother(subject, other, folded));
}

export type SupersedeSubjectFamilyInput = {
  /** The judged claim: it closes, and it defines the subject the siblings are matched on. */
  readonly claimId: string;
  readonly newId: string;
  /**
   * The keyed-close mode this close runs under. Absent is the same answer as `judge` and `off`:
   * a sibling whose key disagrees is decided by the name test and the floor, because only the
   * `close` mode has measured its slugs reliable enough to exclude on one.
   */
  readonly keyedCloseMode?: KeyedCloseMode;
  /** Cosine against the judged claim a sibling must reach before the correction closes it too. */
  readonly relatednessFloor: number;
  readonly now?: Date;
  /**
   * When the correcting experience happened, which is when the closed claims stopped being
   * true. Defaults to `now`.
   */
  readonly validUntil?: Date;
  readonly signals?: readonly string[];
  readonly provenance?: readonly string[];
};

export type SubjectFamilyResult = {
  readonly supersession: SupersedeResult;
  /** The judged claim first, then the siblings that closed with it. */
  readonly closedIds: readonly string[];
  /** The siblings that closed. */
  readonly siblings: readonly SubjectSibling[];
  /**
   * Siblings that named the same subject and were left open, because the correction is not
   * evidence against what they say. Reported rather than dropped: a person who meant to close
   * the whole observation needs to see what the narrower cut left behind.
   */
  readonly heldSiblings: readonly SubjectSibling[];
  /** The subjects the match ran on; empty means the family degraded to the claim alone. */
  readonly subjects: readonly string[];
  /** Descriptions that restated the closed claim and were cleared, entities left in place. */
  readonly retiredGlosses: readonly ClaimSubject[];
  /** Descriptions of the same subjects that stand, because they assert something else. */
  readonly openGlosses: readonly ClaimSubject[];
};

/**
 * Closes the judged claim and the siblings that share its subject, in one transaction. The
 * successor recorded against each sibling is the correction itself rather than a sibling of
 * the correction: nothing in the new observation restates the closed sentence, and a closed
 * node with no lineage is a state the substrate forbids.
 */
export async function supersedeSubjectFamily(
  driver: Driver,
  input: SupersedeSubjectFamilyInput,
): Promise<SubjectFamilyResult> {
  return inWriteTransaction(driver, async (tx: GraphTransaction) =>
    supersedeSubjectFamilyInTransaction(tx, input),
  );
}

/**
 * The same family close joined to a transaction the caller already holds, for a path that has
 * to close in the commit that wrote what corrects it. Subjects are read inside that transaction
 * so the whole close lands as one unit: no reader sees the judged claim closed while its
 * siblings still stand.
 *
 * The transaction does not serialize this against a concurrent entity write. Neo4j reads take
 * no lock and its isolation is read-committed (`locks.ts`), and this path takes no lock, so the
 * family a close takes is the one the graph held when the read ran. Under-taking is the
 * tolerable direction: a sibling a later mention adds stays open and answers, which is visible
 * and reversible with `--episode`.
 */
export async function supersedeSubjectFamilyInTransaction(
  tx: GraphTransaction,
  input: SupersedeSubjectFamilyInput,
): Promise<SubjectFamilyResult> {
  const now = input.now ?? new Date();
  const validUntil = input.validUntil ?? now;

  const subjects = await tx.run(
    SUBJECTS_OF_CLAIM,
    { claimId: input.claimId, minNameLength: toGraphInteger(MIN_SUBJECT_NAME_LENGTH) },
    mapSubject,
  );
  const retired = subjects.filter((subject) => glossRestatesClaim(subject, subjects));

  const supersession = await supersedeInTransaction(tx, {
    oldId: input.claimId,
    newId: input.newId,
    now,
    validUntil,
    ...(input.signals === undefined ? {} : { signals: input.signals }),
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
  });

  const candidates = await tx.run(
    SUBJECT_SIBLINGS,
    siblingParameters(input.claimId, input.keyedCloseMode),
    mapSibling,
  );
  const siblings = candidates.filter((sibling) => siblingCloses(sibling, input.relatednessFloor));
  const held = candidates.filter((sibling) => !siblingCloses(sibling, input.relatednessFloor));
  for (const sibling of siblings) {
    await supersedeInTransaction(tx, {
      oldId: sibling.id,
      newId: input.newId,
      now,
      validUntil,
      signals: SUBJECT_PROPAGATION_SIGNALS,
      provenance: [SUBJECT_PROPAGATION_METHOD],
    });
  }
  for (const subject of retired) {
    await tx.run(
      RETIRE_GLOSS,
      { id: subject.entityId, now: toGraphDateTime(now) },
      (row) => row.id,
    );
  }

  const retiredIds = new Set(retired.map((subject) => subject.entityId));
  return {
    supersession,
    closedIds: [input.claimId, ...siblings.map((sibling) => sibling.id)],
    siblings,
    heldSiblings: held,
    subjects: subjects.map((subject) => subject.name),
    retiredGlosses: retired,
    openGlosses: subjects.filter(
      (subject) => subject.gloss !== undefined && !retiredIds.has(subject.entityId),
    ),
  };
}
