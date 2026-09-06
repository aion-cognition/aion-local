import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, runWrite, type GraphStatement } from './connection.js';
import { upsertEdge } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, EXTRACTION_TYPE } from './labels.js';
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

/** The stated-source edge: `(Episode)-[:DERIVES_FROM]->(what it came from)`. */
export const STATED_SOURCE_TYPE: RelationshipType = 'DERIVES_FROM';

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

/**
 * How many stated references the substrate could not resolve, kept on the episode they were
 * stated about. A descendant reads it and says its lineage is short, which is the alternative
 * to reporting fewer roots as though that were the whole set.
 */
export const UNRESOLVED_REFERENCES_PROPERTY = 'provenance_unresolved';

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
  /** Nearest sources, ordered and cut at the caller's bound. Empty when the substrate holds none. */
  readonly roots: readonly string[];
  /** False when the bound cut the list, or when a stated reference resolved to nothing. */
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

function confirmationStatement(episodeId: string, confirmation: ConfirmationWrite): GraphStatement {
  return {
    cypher: [
      `MATCH (src:${BASE_NODE_LABEL} { id: $episodeId })` +
        `-[r:${CONFIRMATION_TYPE}]->(target:${BASE_NODE_LABEL} { id: $targetId })`,
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
 * claim reaches its episode over `EXTRACTED_FROM`.
 */
function captureStatement(input: ClaimProvenanceInput): GraphStatement {
  const node = readModeFragment(input.mode, 'n');
  const own = readModeFragment(input.mode, 'own', 'rmown');
  const extracted = readModeFragment(input.mode, 'ex', 'rmex');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE ${node.where}`,
    'OPTIONAL MATCH (own:Episode)',
    `WHERE own.id = coalesce(n.${MEMORY_PROPERTIES.sourceEpisodeId}, n.id) AND ${own.where}`,
    'WITH n, collect(DISTINCT own.id) AS ownIds',
    `WITH n, ownIds + [ (n)-[:${EXTRACTION_TYPE}]->(ex:Episode)` +
      ` WHERE ${extracted.where} | ex.id ] AS captureIds`,
    `OPTIONAL MATCH (corrector:Episode)-[:${CORRECTION_TYPE}]->(n)`,
    'WITH n, captureIds, corrector',
    `ORDER BY corrector.${BITEMPORAL_PROPERTIES.txFrom} DESC, corrector.id`,
    'WITH n, captureIds, head(collect(corrector)) AS corrector',
    `OPTIONAL MATCH (:Episode)-[ev:${CONFIRMATION_TYPE}]->(n)`,
    `WHERE ev.${CONFIRMATION_PROPERTIES.by} IS NOT NULL`,
    'WITH n, captureIds, corrector, ev',
    `ORDER BY ev.${CONFIRMATION_PROPERTIES.at} DESC`,
    'WITH n, captureIds, corrector, head(collect(ev)) AS ev',
    'RETURN n.id AS id,',
    '       captureIds AS capture_ids,',
    `       n.${MEMORY_PROPERTIES.role} AS recorded_role,`,
    '       corrector.id AS corrected_by,',
    `       corrector.${BITEMPORAL_PROPERTIES.txFrom} AS corrected_at,`,
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

type CaptureSources = {
  readonly roots: readonly string[];
  readonly unresolved: number;
};

/**
 * What each capture was stated to have come from. A capture with no stated source stands as its
 * own root, which is what makes two turns of one episode read as one witness.
 */
function sourceStatement(captureIds: readonly string[], mode: ReadMode): GraphStatement {
  const capture = readModeFragment(mode, 'c');
  const root = readModeFragment(mode, 'root', 'rmroot');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (c:Episode { id: wantedId })`,
    `WHERE ${capture.where}`,
    `OPTIONAL MATCH (c)-[:${STATED_SOURCE_TYPE}]->(root:${BASE_NODE_LABEL})`,
    `WHERE ${root.where}`,
    'WITH c, root',
    'ORDER BY root.id',
    'RETURN c.id AS id,',
    '       collect(DISTINCT root.id) AS roots,',
    `       coalesce(c.${UNRESOLVED_REFERENCES_PROPERTY}, 0) AS unresolved`,
  ].join('\n');
  return {
    cypher,
    parameters: { ...capture.parameters, ...root.parameters, ids: [...new Set(captureIds)] },
  };
}

export type ClaimProvenanceInput = {
  readonly ids: readonly string[];
  /** Nearest roots per item. A wider set reports `complete: false` rather than growing. */
  readonly maxRoots: number;
  readonly mode: ReadMode;
};

function foldSources(
  captures: readonly string[],
  sources: ReadonlyMap<string, CaptureSources>,
  maxRoots: number,
): { roots: readonly string[]; complete: boolean } {
  const roots = new Set<string>();
  let unresolved = 0;
  for (const capture of captures) {
    const source = sources.get(capture);
    if (source === undefined) {
      roots.add(capture);
      continue;
    }
    unresolved += source.unresolved;
    if (source.roots.length === 0) {
      roots.add(capture);
      continue;
    }
    for (const root of source.roots) {
      roots.add(root);
    }
  }
  const ordered = [...roots].sort();
  return {
    roots: ordered.slice(0, maxRoots),
    complete: ordered.length <= maxRoots && unresolved === 0,
  };
}

/**
 * Two batched reads: what each candidate's capture is, and what those captures were stated to
 * come from. An id missing from the answer carries no source record, which a caller has to
 * read as unknown rather than as having none.
 */
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

  const sourceRows =
    captureIds.size === 0
      ? []
      : await runRead(driver, sourceStatement([...captureIds], input.mode), (row: Row) => ({
          id: row.id as string,
          roots: ((row.roots as string[] | null) ?? []).filter((id) => id.length > 0),
          unresolved: (row.unresolved as number | null) ?? 0,
        }));
  const sources = new Map<string, CaptureSources>(
    sourceRows.map((row) => [row.id, { roots: row.roots, unresolved: row.unresolved }]),
  );

  return new Map(
    captures.map((row) => [
      row.id,
      {
        ...foldSources(row.captureIds, sources, input.maxRoots),
        ...(row.recordedRole === undefined ? {} : { recordedRole: row.recordedRole }),
        ...(row.confirmation === undefined ? {} : { confirmation: row.confirmation }),
        ...(row.claimedCorrection === undefined
          ? {}
          : { claimedCorrection: row.claimedCorrection }),
      },
    ]),
  );
}
