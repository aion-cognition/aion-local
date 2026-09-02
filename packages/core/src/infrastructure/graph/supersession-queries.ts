import type { Driver } from 'neo4j-driver';

import { currentOnly } from './bitemporal.js';
import type { CognitiveNodeLabel } from './cognitive-queries.js';
import { TEXT_NORM_PROPERTY } from './cognitive-text.js';
import { runRead, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, MEMORY_LABEL } from './labels.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import { ENTITY_NAME_NORM_PROPERTY, ENTITY_NAME_PROPERTY } from './seed-queries.js';
import { fromGraphVector, toGraphInteger, toGraphVector, type Row } from './values.js';
import { asCosine } from './vector-indexes.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
} from '../../reflection/domain/claim-key.js';
import type { Vector } from '../providers/types.js';

/**
 * The graph reads behind supersession detection. The stage decides what contradicts what;
 * this module knows which nodes carry a fact worth contradicting and how to find the
 * current neighbours of one.
 */

/**
 * The fact-bearing subset of the nine cognitive types. Decision and Insight assert a
 * position; Concept and Event are where operational parameters and their values actually
 * land, measured over the substrate, so a scan that omits them misses most real corrections.
 * `satisfies` fails to compile if a label here drifts from the closed set
 * `cognitive-queries.ts` writes.
 */
export const FACT_NODE_LABELS = [
  'Decision',
  'Insight',
  'Concept',
  'Event',
] as const satisfies readonly CognitiveNodeLabel[];

/** Cypher label expression over the fact set: one label scan per label, no full store scan. */
const FACT_LABEL_EXPRESSION = FACT_NODE_LABELS.join('|');

/**
 * A one- or two-character surface form is a substring of nearly every claim, so a name that
 * short cannot establish that two statements share a subject.
 */
export const MIN_SUBJECT_NAME_LENGTH = 3;

export type FactNodeLabel = (typeof FACT_NODE_LABELS)[number];

export function isFactNodeLabel(value: string): value is FactNodeLabel {
  return (FACT_NODE_LABELS as readonly string[]).includes(value);
}

/** Appendix B provenance: which pipeline path closed the old node. */
export const SUPERSESSION_METHOD = 'reflection_supersession';

export type EpisodeFactNode = {
  readonly id: string;
  readonly label: FactNodeLabel;
  readonly text: string;
  /** The stored fold, so the subject search matches names without recomputing it. */
  readonly textNorm: string;
  /** Absent while the node is still a pending-vector marker; such a node cannot search for neighbours. */
  readonly contentVector?: Vector;
  /**
   * The claim's key, when extraction named a subject the graph holds and an attribute it could
   * fold. Both halves land together or neither does, so a node carrying one is a node with none.
   */
  readonly subjectEntityId?: string;
  readonly aspectNorm?: string;
};

function episodeFactNodesStatement(episodeId: string, reference?: Date): GraphStatement {
  const fragment = readModeFragment(withCurrency(reference), 'n');
  return {
    cypher: [
      'MATCH (:Episode { id: $episodeId })<-[:EXTRACTED_FROM]-(n)',
      `WHERE any(label IN labels(n) WHERE label IN $labels) AND ${fragment.where}`,
      'RETURN n.id AS id, [label IN labels(n) WHERE label IN $labels][0] AS label,',
      `       n.${MEMORY_PROPERTIES.text} AS text, n.${TEXT_NORM_PROPERTY} AS text_norm,`,
      `       n.${MEMORY_PROPERTIES.contentVector} AS content_vec,`,
      `       n.${CLAIM_SUBJECT_PROPERTY} AS subject_entity_id, n.${CLAIM_ASPECT_PROPERTY} AS aspect_norm`,
      `ORDER BY n.${TEXT_NORM_PROPERTY}, n.id`,
    ].join('\n'),
    parameters: { episodeId, labels: [...FACT_NODE_LABELS], ...fragment.parameters },
  };
}

/**
 * This episode's fact-bearing nodes, in a stable order so a bounded run always truncates the
 * same way. Returns `[]` when cognitive extraction has not run for the episode: the
 * not-assumed-to-have-run contract every stage after extraction follows.
 */
export async function findEpisodeFactNodes(
  driver: Driver,
  episodeId: string,
  /** The clock currency is judged from; the wall clock when a caller holds none. */
  reference?: Date,
): Promise<EpisodeFactNode[]> {
  const rows = await runRead(
    driver,
    episodeFactNodesStatement(episodeId, reference),
    mapEpisodeFactNode,
  );
  return rows.filter((row): row is EpisodeFactNode => row !== undefined);
}

function mapEpisodeFactNode(row: Row): EpisodeFactNode | undefined {
  const label = (row.label as string | null) ?? '';
  if (!isFactNodeLabel(label)) {
    return undefined;
  }
  const contentVector = fromGraphVector(row.content_vec);
  const subjectEntityId = row.subject_entity_id as string | null;
  const aspectNorm = row.aspect_norm as string | null;
  return {
    id: row.id as string,
    label,
    text: (row.text as string | null) ?? '',
    textNorm: (row.text_norm as string | null) ?? '',
    ...(contentVector === undefined ? {} : { contentVector }),
    ...(subjectEntityId === null ? {} : { subjectEntityId }),
    ...(aspectNorm === null ? {} : { aspectNorm }),
  };
}

/**
 * Of these ids, the ones that no longer hold currency. The judgment path reads it just before
 * it writes, because a judgment whose losing side lost currency in the meantime did not close
 * anything and must not be scored as though it had: a family close taken earlier in the same
 * run, or a person applying a neighbouring proposal, both leave a pair the judge still believes
 * in with nothing left to take. Two-way outcome reporting cannot tell that apart from a real
 * closure, and reports it as one.
 *
 * An id the graph does not know is reported as gone: nothing there holds currency either.
 */
const NODES_WITHOUT_CURRENCY = [
  'UNWIND $ids AS wanted',
  `OPTIONAL MATCH (n:${BASE_NODE_LABEL} { id: wanted })`,
  `WHERE ${currentOnly('n')}`,
  'WITH wanted, n',
  'WHERE n IS NULL',
  'RETURN wanted AS id',
  'ORDER BY id',
].join('\n');

export async function findNodesWithoutCurrency(
  driver: Driver,
  ids: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) {
    return [];
  }
  return runRead(driver, NODES_WITHOUT_CURRENCY, { ids: wanted }, (row) => row.id as string);
}

export type ContradictionCandidate = {
  readonly id: string;
  readonly label: FactNodeLabel;
  readonly text: string;
  readonly score: number;
  /** How the candidate was reached: a shared subject, or bare embedding proximity. */
  readonly matchedBy: CandidateMatch;
  /** The subject both statements name, when the shared-subject leg found it. */
  readonly sharedSubject?: string;
};

export type CandidateMatch = 'subject' | 'knn' | 'key';

function toCandidate(row: Row, matchedBy: CandidateMatch): ContradictionCandidate | undefined {
  const label = (row.label as string | null) ?? '';
  if (!isFactNodeLabel(label)) {
    return undefined;
  }
  const sharedSubject = (row.shared_subject as string | null | undefined) ?? '';
  return {
    id: row.id as string,
    label,
    text: (row.text as string | null) ?? '',
    score: typeof row.score === 'number' ? row.score : 0,
    matchedBy,
    ...(sharedSubject.length === 0 ? {} : { sharedSubject }),
  };
}

function mapSubjectCandidate(row: Row): ContradictionCandidate | undefined {
  return toCandidate(row, 'subject');
}

function mapKeyedCandidate(row: Row): ContradictionCandidate | undefined {
  return toCandidate(row, 'key');
}

function mapVectorCandidate(row: Row): ContradictionCandidate | undefined {
  return toCandidate(row, 'knn');
}

/**
 * The claims that already state this claim's key: one subject entity, one folded aspect, still
 * open, and extracted somewhere other than this episode. Nothing is compared as text, because
 * the key states what the containment test was standing in for.
 *
 * `Memory` anchors the seek, since that is the label the composite key index is declared on, and
 * the fact labels are a post-filter over the handful of rows it returns. The subject's own name
 * rides along so the judge is told what both statements are about, the same line the subject leg
 * supplies from a name match.
 */
const KEYED_CANDIDATES = [
  `MATCH (n:${MEMORY_LABEL})`,
  `WHERE n.${CLAIM_SUBJECT_PROPERTY} = $subjectEntityId`,
  `  AND n.${CLAIM_ASPECT_PROPERTY} = $aspectNorm`,
  '  AND any(label IN labels(n) WHERE label IN $labels)',
  `  AND ${currentOnly('n')}`,
  '  AND NOT n.id IN $excludeIds',
  'OPTIONAL MATCH (subject:Entity { id: $subjectEntityId })',
  'WITH n, subject, [label IN labels(n) WHERE label IN $labels][0] AS label,',
  `     CASE WHEN n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `          AND size(n.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `          THEN ${asCosine(`vector.similarity.cosine(n.${MEMORY_PROPERTIES.contentVector}, $vector)`)}`,
  '          ELSE 0.0 END AS score',
  `RETURN n.id AS id, label, n.${MEMORY_PROPERTIES.text} AS text, score,`,
  `       subject.${ENTITY_NAME_PROPERTY} AS shared_subject`,
  'ORDER BY score DESC, n.id',
  'LIMIT $limit',
].join('\n');

export type KeyedCandidateInput = {
  readonly subjectEntityId: string;
  readonly aspectNorm: string;
  /** The subject claim's own vector, scored for ordering only: the key already made the match. */
  readonly vector: Vector;
  /** The subject and its episode siblings, which is what keeps one observation off itself. */
  readonly excludeIds: readonly string[];
  readonly limit: number;
};

export async function findKeyedCandidates(
  driver: Driver,
  input: KeyedCandidateInput,
): Promise<ContradictionCandidate[]> {
  const rows = await runRead(
    driver,
    KEYED_CANDIDATES,
    {
      subjectEntityId: input.subjectEntityId,
      aspectNorm: input.aspectNorm,
      labels: [...FACT_NODE_LABELS],
      excludeIds: [...input.excludeIds],
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      limit: toGraphInteger(input.limit),
    },
    mapKeyedCandidate,
  );
  return rows.filter((row): row is ContradictionCandidate => row !== undefined);
}

/**
 * The claims that name what this one names. Both sides of a real reversal restate the same
 * subject, and measured results show embedding proximity alone neither finds those pairs
 * (a concise restatement of a reversal scored 0.67) nor keeps unrelated ones out (three
 * false closures, all near neighbours on shared vocabulary).
 *
 * A subject is an Entity the source episode already extracted, so no keyword machinery
 * enters the path: the names are the model's own, the fold is the one the entity writer
 * stored, and the match is a substring test between two stored normalizations. The candidate
 * qualifies either by naming that entity in its own claim or by hanging off an episode that
 * mentions it.
 *
 * Cross-label on purpose: the substrate puts a parameter's baseline in a Concept and its
 * correction in a Decision, so requiring equal labels drops the pair that matters most.
 */
const SUBJECT_IDENTITY_CANDIDATES = [
  `MATCH (:Episode { id: $episodeId })-[:${ENTITY_MENTION_TYPE}]->(e:Entity)`,
  `WHERE ${currentOnly('e')}`,
  `  AND size(e.${ENTITY_NAME_NORM_PROPERTY}) >= $minNameLength`,
  `  AND $subjectTextNorm CONTAINS e.${ENTITY_NAME_NORM_PROPERTY}`,
  `WITH collect(DISTINCT e.id) AS subjectIds, collect(DISTINCT e.${ENTITY_NAME_NORM_PROPERTY}) AS names`,
  'WITH subjectIds, names WHERE size(subjectIds) > 0',
  `MATCH (n:${FACT_LABEL_EXPRESSION})`,
  `WHERE ${currentOnly('n')}`,
  '  AND NOT n.id IN $excludeIds',
  `  AND (head([name IN names WHERE n.${TEXT_NORM_PROPERTY} CONTAINS name]) IS NOT NULL`,
  '       OR EXISTS {',
  `         MATCH (n)-[:EXTRACTED_FROM]->(:Episode)-[:${ENTITY_MENTION_TYPE}]->(shared:Entity)`,
  '         WHERE shared.id IN subjectIds',
  '       })',
  `WITH n, names, [label IN labels(n) WHERE label IN $labels][0] AS label,`,
  `     CASE WHEN n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `          AND size(n.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `          THEN ${asCosine(`vector.similarity.cosine(n.${MEMORY_PROPERTIES.contentVector}, $vector)`)}`,
  '          ELSE 0.0 END AS score',
  `RETURN n.id AS id, label, n.${MEMORY_PROPERTIES.text} AS text, score,`,
  `       head([name IN names WHERE n.${TEXT_NORM_PROPERTY} CONTAINS name]) AS shared_subject`,
  'ORDER BY score DESC, n.id',
  'LIMIT $limit',
].join('\n');

export type SubjectIdentityCandidateInput = {
  /** The episode whose entities define the subject set. */
  readonly episodeId: string;
  /** The subject claim's stored fold; an entity name has to appear inside it. */
  readonly subjectTextNorm: string;
  readonly vector: Vector;
  /** The subject and its episode siblings: an episode's own nodes never supersede each other. */
  readonly excludeIds: readonly string[];
  readonly limit: number;
};

export async function findSubjectIdentityCandidates(
  driver: Driver,
  input: SubjectIdentityCandidateInput,
): Promise<ContradictionCandidate[]> {
  const rows = await runRead(
    driver,
    SUBJECT_IDENTITY_CANDIDATES,
    {
      episodeId: input.episodeId,
      subjectTextNorm: input.subjectTextNorm,
      labels: [...FACT_NODE_LABELS],
      excludeIds: [...input.excludeIds],
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      minNameLength: toGraphInteger(MIN_SUBJECT_NAME_LENGTH),
      limit: toGraphInteger(input.limit),
    },
    mapSubjectCandidate,
  );
  return rows.filter((row): row is ContradictionCandidate => row !== undefined);
}

/**
 * The secondary widener, kept for the claims whose subject the entity extractor never named.
 * Currency-filtered, unlike recall's currency-aware reads: a node that lost currency has
 * already been superseded, and closing it a second time asserts a lineage the substrate did
 * not observe.
 *
 * The scan is over the labels rather than through `content_vec_idx` on purpose: the index
 * picks its k nearest before any predicate runs, so currency and the exclusion list would
 * spend slots on rows that cannot qualify. `vector.similarity.cosine` rescales onto [0,1] the
 * same way the index does, so the score is converted back to a true cosine before it meets a
 * threshold pinned as one. Matches `findSimilarCurrentEntities`.
 */
const CONTRADICTION_CANDIDATES = [
  `MATCH (n:${FACT_LABEL_EXPRESSION})`,
  `WHERE ${currentOnly('n')}`,
  '  AND NOT n.id IN $excludeIds',
  `  AND n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `  AND size(n.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `WITH n, [label IN labels(n) WHERE label IN $labels][0] AS label,`,
  `     ${asCosine(`vector.similarity.cosine(n.${MEMORY_PROPERTIES.contentVector}, $vector)`)} AS score`,
  'WHERE score >= $threshold',
  `RETURN n.id AS id, label, n.${MEMORY_PROPERTIES.text} AS text, score, null AS shared_subject`,
  'ORDER BY score DESC, n.id',
  'LIMIT $limit',
].join('\n');

export type ContradictionCandidateInput = {
  readonly vector: Vector;
  /** The subject, its episode siblings, and anything the subject leg already returned. */
  readonly excludeIds: readonly string[];
  readonly threshold: number;
  readonly limit: number;
};

export async function findContradictionCandidates(
  driver: Driver,
  input: ContradictionCandidateInput,
): Promise<ContradictionCandidate[]> {
  const rows = await runRead(
    driver,
    CONTRADICTION_CANDIDATES,
    {
      labels: [...FACT_NODE_LABELS],
      excludeIds: [...input.excludeIds],
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      threshold: input.threshold,
      limit: toGraphInteger(input.limit),
    },
    mapVectorCandidate,
  );
  return rows.filter((row): row is ContradictionCandidate => row !== undefined);
}
