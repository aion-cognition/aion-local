import type { Driver } from 'neo4j-driver';

import { EDGE_RECORDED_AT, edgeVisibility } from './adjacency.js';
import {
  foldAncestry,
  readAncestry,
  STATED_SOURCE_TYPE,
  UNRESOLVED_REFERENCES_PROPERTY,
} from './claim-lineage-queries.js';
import { runRead, runWrite, type GraphStatement, type GraphTransaction } from './connection.js';
import { upsertEdge, upsertEdgeInTransaction } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, EXTRACTION_TYPE } from './labels.js';
import { NARRATIVE_LABEL } from './narrative-queries.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import type { RelationshipType } from './relationships.js';
import { toGraphDateTime, toGraphInteger, type Row } from './values.js';

/**
 * The source record behind a memory: what it descends from, what somebody stated corrects it,
 * and whether anyone confirmed it with evidence that names them.
 *
 * Two reference kinds are written here and they stay apart. A derivation says a memory came
 * from somewhere and asserts no disagreement; a correction says somebody holds a memory to be
 * wrong. Neither closes lineage. Closure belongs to the supersession judge, and a reference the
 * caller supplied is evidence for it rather than a substitute for it, so a corrected node keeps
 * answering as current until the judge says otherwise.
 *
 * A root reaches a claim through its capture, so two claims extracted from one episode report
 * the same root and a pack holding both can say they are one witness rather than two.
 */

/** The claimed-correction edge: `(Episode)-[:CORRECTS]->(node the caller says is wrong)`. */
export const CORRECTION_TYPE: RelationshipType = 'CORRECTS';

/** The edge a confirmation record hangs on, its three properties written beside the standard shape. */
export const CONFIRMATION_TYPE: RelationshipType = 'EVIDENCES';

/** Provenance on every edge this module writes, so `aion why` can name the path that made it. */
export const CLAIM_PROVENANCE_METHOD = 'reflection_provenance';

const PROVENANCE_SIGNALS = ['stated'];
const PROVENANCE_PROVENANCE = [CLAIM_PROVENANCE_METHOD];

export const CONFIRMATION_PROPERTIES = {
  by: 'confirmed_by',
  at: 'confirmed_at',
  evidence: 'confirmation_evidence',
} as const;

export type ConfirmationEvidence = {
  readonly by: string;
  readonly at: Date;
  readonly evidence: string;
};

export type ClaimedCorrection = {
  /** The episode whose reflection call stated the correction. */
  readonly by: string;
  readonly at: Date;
};

export type ItemProvenance = {
  /** Terminal sources, ordered and cut at the caller's bound. Empty when the substrate holds none. */
  readonly roots: readonly string[];
  /**
   * Every ancestor the walk reached, the item's own capture and the intermediate captures
   * included, unbounded by `maxRoots`. Two memories are one witness when these sets meet, and
   * a terminal root alone cannot answer that: a capture and a claim extracted from it share the
   * capture and nothing further up. Optional, because a caller assembling a record by hand is
   * saying the roots are all the overlap it knows.
   */
  readonly lineage?: readonly string[];
  /** False when the walk hit its hop bound, or when a stated reference resolved to nothing. */
  readonly complete: boolean;
  /**
   * The role capture stored on a Turn, verbatim. It says something was said and never who said
   * it: agent-to-agent traffic arrives under `user` like every other caller's does. Absent on
   * every node type that stores no role.
   */
  readonly recordedRole?: string;
  readonly confirmation?: ConfirmationEvidence;
  readonly claimedCorrection?: ClaimedCorrection;
};

export type ProvenanceTargetInput = {
  readonly ids: readonly string[];
  readonly mode: ReadMode;
};

function targetStatement(input: ProvenanceTargetInput): GraphStatement {
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE ${fragment.where}`,
    'RETURN n.id AS id',
  ].join('\n');
  return { cypher, parameters: { ...fragment.parameters, ids: [...new Set(input.ids)] } };
}

/**
 * Which of the named ids the substrate actually holds. A caller may state a reference to
 * anything, and this is what keeps an unresolvable one out of the graph: it is dropped and
 * counted, and no edge is written to stand in for it.
 */
export async function resolveProvenanceTargets(
  driver: Driver,
  input: ProvenanceTargetInput,
): Promise<ReadonlySet<string>> {
  if (input.ids.length === 0) {
    return new Set();
  }
  const rows = await runRead(driver, targetStatement(input), (row: Row) => row.id as string);
  return new Set(rows);
}

export type ConfirmationWrite = ConfirmationEvidence & {
  readonly target: string;
};

export type ClaimProvenanceWrite = {
  /** The episode the reflection call produced. Every edge written here starts at it. */
  readonly episodeId: string;
  readonly derivedFrom: readonly string[];
  readonly corrects: readonly string[];
  readonly confirmations: readonly ConfirmationWrite[];
  /** Stated references that resolved to nothing. Recorded, never filled in. */
  readonly unresolved: number;
  readonly now: Date;
};

/**
 * The confirmation properties, written once and never rewritten.
 *
 * A retry of the same experience resolves to the same episode and reaches the same edge, and a
 * retry carries a fresh clock whenever the caller stated no time of its own. Overwriting would
 * move the confirmation's recorded moment forward every time a client resent a payload, change
 * what a session had already been served, and reorder which confirmation counts as the newest.
 * The first record stands: an edge already carrying a confirmer is left exactly as it was, and
 * a caller with something new to say about the same target says it in a new experience, which
 * is a different episode and a different edge.
 */
function confirmationStatement(episodeId: string, confirmation: ConfirmationWrite): GraphStatement {
  return {
    cypher: [
      `MATCH (src:${BASE_NODE_LABEL} { id: $episodeId })` +
        `-[r:${CONFIRMATION_TYPE}]->(target:${BASE_NODE_LABEL} { id: $targetId })`,
      `WHERE r.${CONFIRMATION_PROPERTIES.by} IS NULL`,
      `SET r.${CONFIRMATION_PROPERTIES.by} = $by,`,
      `    r.${CONFIRMATION_PROPERTIES.at} = $at,`,
      `    r.${CONFIRMATION_PROPERTIES.evidence} = $evidence`,
    ].join('\n'),
    parameters: {
      episodeId,
      targetId: confirmation.target,
      by: confirmation.by,
      at: toGraphDateTime(confirmation.at),
      evidence: confirmation.evidence,
    },
  };
}

function unresolvedStatement(episodeId: string, unresolved: number): GraphStatement {
  return {
    cypher: [
      `MATCH (n:${BASE_NODE_LABEL} { id: $episodeId })`,
      `SET n.${UNRESOLVED_REFERENCES_PROPERTY} = $unresolved`,
    ].join('\n'),
    parameters: { episodeId, unresolved: toGraphInteger(unresolved) },
  };
}

/**
 * The same edges inside a caller's transaction, for a writer that publishes them under the
 * publication guard. Only targets the graph actually holds are passed: a reference to an
 * endpoint that is not projected is durable in the identity records, and writing an edge to a
 * node that is not there would be a lineage pointer at nothing.
 */
export async function writeClaimProvenanceInTransaction(
  tx: GraphTransaction,
  input: ClaimProvenanceWrite,
): Promise<void> {
  for (const targetId of input.derivedFrom) {
    await linkStatedInTransaction(tx, STATED_SOURCE_TYPE, input.episodeId, targetId, input.now);
  }
  for (const targetId of input.corrects) {
    await linkStatedInTransaction(tx, CORRECTION_TYPE, input.episodeId, targetId, input.now);
  }
  for (const confirmation of input.confirmations) {
    await linkStatedInTransaction(
      tx,
      CONFIRMATION_TYPE,
      input.episodeId,
      confirmation.target,
      input.now,
    );
    const statement = confirmationStatement(input.episodeId, confirmation);
    await tx.run(statement.cypher, statement.parameters, () => undefined);
  }
  if (input.unresolved > 0) {
    const statement = unresolvedStatement(input.episodeId, input.unresolved);
    await tx.run(statement.cypher, statement.parameters, () => undefined);
  }
}

async function linkStatedInTransaction(
  tx: GraphTransaction,
  type: RelationshipType,
  episodeId: string,
  targetId: string,
  now: Date,
): Promise<void> {
  await upsertEdgeInTransaction(tx, {
    type,
    sourceId: episodeId,
    targetId,
    strength: 1,
    confidence: 1,
    signals: PROVENANCE_SIGNALS,
    provenance: PROVENANCE_PROVENANCE,
    count: 0,
    now,
  });
}

async function linkStated(
  driver: Driver,
  type: RelationshipType,
  episodeId: string,
  targetId: string,
  now: Date,
): Promise<void> {
  await upsertEdge(driver, {
    type,
    sourceId: episodeId,
    targetId,
    strength: 1,
    confidence: 1,
    signals: PROVENANCE_SIGNALS,
    provenance: PROVENANCE_PROVENANCE,
    count: 0,
    now,
  });
}

/**
 * The stated references as graph edges, every write idempotent, so a re-pushed payload
 * converges on the same edges rather than adding a second copy of each.
 *
 * A confirmation lands as an evidence edge plus its three properties: the edge carries the
 * standard shape every other edge has, and the properties carry who confirmed, when, and the
 * reference the confirmation is recorded under. The pack cites that reference rather than
 * asserting the confirmation on its own authority.
 */
export async function writeClaimProvenance(
  driver: Driver,
  input: ClaimProvenanceWrite,
): Promise<void> {
  for (const targetId of input.derivedFrom) {
    await linkStated(driver, STATED_SOURCE_TYPE, input.episodeId, targetId, input.now);
  }
  for (const targetId of input.corrects) {
    await linkStated(driver, CORRECTION_TYPE, input.episodeId, targetId, input.now);
  }
  for (const confirmation of input.confirmations) {
    await linkStated(driver, CONFIRMATION_TYPE, input.episodeId, confirmation.target, input.now);
    await runWrite(driver, confirmationStatement(input.episodeId, confirmation), () => undefined);
  }
  if (input.unresolved > 0) {
    await runWrite(driver, unresolvedStatement(input.episodeId, input.unresolved), () => undefined);
  }
}

type CaptureRow = {
  readonly id: string;
  readonly captureIds: readonly string[];
  readonly recordedRole?: string;
  readonly confirmation?: ConfirmationEvidence;
  readonly claimedCorrection?: ClaimedCorrection;
};

/**
 * Each candidate's own capture, plus whatever the substrate holds about it: the newest stated
 * correction pointing at it, and the newest confirmation record naming a confirmer.
 *
 * The capture is reached by id equality rather than by scanning episodes: a Turn or a claim
 * names its episode in `source_episode_id`, an Episode is its own capture, and an extracted
 * claim reaches its episode over `EXTRACTED_FROM`. A Narrative has none of the three and starts
 * the walk at itself, so the step below can ask it what its stored sentences cited.
 *
 * Every arm carries the read mode, the evidence edges included. A correction and a confirmation
 * are records the substrate acquired at a moment, so a read pinned before that moment must not
 * see them: a pack answering what was known on Tuesday cannot carry Friday's correction. The
 * node filter alone is not enough, because a reference written later between two nodes that
 * both already existed leaks backward through it.
 */
function captureStatement(input: ClaimProvenanceInput): GraphStatement {
  const node = readModeFragment(input.mode, 'n');
  const own = readModeFragment(input.mode, 'own', 'rmown');
  const extracted = readModeFragment(input.mode, 'ex', 'rmex');
  const corrector = readModeFragment(input.mode, 'corrector', 'rmcorr');
  const witness = readModeFragment(input.mode, 'witness', 'rmwit');
  const correctionEdge = edgeVisibility(input.mode, 'cr', 'rmcorr');
  const evidenceEdge = edgeVisibility(input.mode, 'ev', 'rmwit');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE ${node.where}`,
    'OPTIONAL MATCH (own:Episode)',
    `WHERE own.id = coalesce(n.${MEMORY_PROPERTIES.sourceEpisodeId}, n.id) AND ${own.where}`,
    'WITH n, collect(DISTINCT own.id) AS ownIds',
    `WITH n, ownIds + [ (n)-[:${EXTRACTION_TYPE}]->(ex:Episode)` +
      ` WHERE ${extracted.where} | ex.id ]` +
      ` + CASE WHEN $narrativeLabel IN labels(n) THEN [n.id] ELSE [] END AS captureIds`,
    `OPTIONAL MATCH (corrector:Episode)-[cr:${CORRECTION_TYPE}]->(n)`,
    `WHERE ${corrector.where} AND ${correctionEdge}`,
    'WITH n, captureIds, corrector, cr',
    `ORDER BY cr.${EDGE_RECORDED_AT} DESC, corrector.id`,
    'WITH n, captureIds, head(collect({ id: corrector.id, at: cr.' +
      `${EDGE_RECORDED_AT} })) AS correction`,
    `OPTIONAL MATCH (witness:Episode)-[ev:${CONFIRMATION_TYPE}]->(n)`,
    `WHERE ev.${CONFIRMATION_PROPERTIES.by} IS NOT NULL`,
    `  AND ${witness.where} AND ${evidenceEdge}`,
    'WITH n, captureIds, correction, ev',
    `ORDER BY ev.${CONFIRMATION_PROPERTIES.at} DESC`,
    'WITH n, captureIds, correction, head(collect(ev)) AS ev',
    'RETURN n.id AS id,',
    '       captureIds AS capture_ids,',
    `       n.${MEMORY_PROPERTIES.role} AS recorded_role,`,
    '       correction.id AS corrected_by,',
    '       correction.at AS corrected_at,',
    `       ev.${CONFIRMATION_PROPERTIES.by} AS confirmed_by,`,
    `       ev.${CONFIRMATION_PROPERTIES.at} AS confirmed_at,`,
    `       ev.${CONFIRMATION_PROPERTIES.evidence} AS confirmation_evidence`,
  ].join('\n');

  return {
    cypher,
    parameters: {
      ...node.parameters,
      ...own.parameters,
      ...extracted.parameters,
      ...corrector.parameters,
      ...witness.parameters,
      narrativeLabel: NARRATIVE_LABEL,
      ids: [...new Set(input.ids)],
    },
  };
}

function mapCapture(row: Row): CaptureRow {
  const confirmedBy = row.confirmed_by;
  const confirmedAt = row.confirmed_at;
  const evidence = row.confirmation_evidence;
  const correctedBy = row.corrected_by;
  const correctedAt = row.corrected_at;
  return {
    id: row.id as string,
    captureIds: ((row.capture_ids as string[] | null) ?? []).filter((id) => id.length > 0),
    ...(typeof row.recorded_role === 'string' && row.recorded_role.length > 0
      ? { recordedRole: row.recorded_role }
      : {}),
    ...(typeof confirmedBy === 'string' &&
    confirmedAt instanceof Date &&
    typeof evidence === 'string'
      ? { confirmation: { by: confirmedBy, at: confirmedAt, evidence } }
      : {}),
    ...(typeof correctedBy === 'string' && correctedAt instanceof Date
      ? { claimedCorrection: { by: correctedBy, at: correctedAt } }
      : {}),
  };
}

export type ClaimProvenanceInput = {
  readonly ids: readonly string[];
  /** Nearest roots per item. A wider set reports `complete: false` rather than growing. */
  readonly maxRoots: number;
  readonly mode: ReadMode;
};

export async function fetchClaimProvenance(
  driver: Driver,
  input: ClaimProvenanceInput,
): Promise<ReadonlyMap<string, ItemProvenance>> {
  if (input.ids.length === 0) {
    return new Map();
  }
  const captures = await runRead(driver, captureStatement(input), mapCapture);
  const captureIds = new Set<string>();
  for (const row of captures) {
    for (const capture of row.captureIds) {
      captureIds.add(capture);
    }
  }

  const sources = await readAncestry(driver, captureIds, input.mode);

  return new Map(
    captures.map((row) => [
      row.id,
      {
        ...foldAncestry(row.captureIds, sources, input.maxRoots),
        ...(row.recordedRole === undefined ? {} : { recordedRole: row.recordedRole }),
        ...(row.confirmation === undefined ? {} : { confirmation: row.confirmation }),
        ...(row.claimedCorrection === undefined
          ? {}
          : { claimedCorrection: row.claimedCorrection }),
      },
    ]),
  );
}
