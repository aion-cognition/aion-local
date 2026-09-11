import type { Driver } from 'neo4j-driver';

import { currentOnly } from './bitemporal.js';
import { runRead, type GraphTransaction } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from './narrative-queries.js';
import { toGraphInteger, type Row } from './values.js';
import { fromGraphDateTime } from './values.js';

/** A projection's transaction stamp, not its claimed world occurrence time. */
export async function readSourceProjectionTime(
  tx: GraphTransaction,
  sourceId: string,
): Promise<string | undefined> {
  const rows = await tx.run(
    'MATCH (e:Episode {id: $sourceId}) RETURN e.tx_from AS stamp LIMIT 1',
    { sourceId },
    (row) => fromGraphDateTime(row.stamp)?.toISOString(),
  );
  return rows[0];
}

/** Publication identity distinguishes new prepared nodes from original legacy versions. */
export const NARRATIVE_PUBLISHED_BY = 'narrative_published_by';

/** Representation retirement names its publication; the canonical time belongs to that ACK. */
export const REPRESENTATION_RETIRED_BY = 'representation_retired_by';

export type NarrativeFamilyIdentity = {
  readonly nodeId: string;
  readonly sessionId?: string;
  readonly family: 'legacy_session_overview' | 'chunk' | 'overview' | 'unknown';
  readonly retirementOperationId?: string;
  readonly publicationOperationId?: string;
};

const IDENTITIES = [
  'UNWIND $ids AS wanted',
  'MATCH (n:Narrative { id: wanted })',
  `OPTIONAL MATCH (n)-[:${DERIVES_FROM_TYPE}]->(s:Session)`,
  `RETURN n.id AS id, n.${MEMORY_PROPERTIES.sessionId} AS session_id, collect(DISTINCT s.id) AS sessions,`,
  `       n.${NARRATIVE_PROPERTIES.family} AS family, n.${NARRATIVE_PROPERTIES.scope} AS scope,`,
  `       n.${REPRESENTATION_RETIRED_BY} AS retired_by, n.${NARRATIVE_PUBLISHED_BY} AS published_by`,
].join('\n');

function identity(row: Row): NarrativeFamilyIdentity {
  const sessions = new Set<string>(Array.isArray(row.sessions) ? (row.sessions as string[]) : []);
  if (typeof row.session_id === 'string') {
    sessions.add(row.session_id);
  }
  let family: NarrativeFamilyIdentity['family'] = 'unknown';
  if (row.family === 'chunk' || row.family === 'overview') {
    ({ family } = row);
  } else if (
    row.family === 'legacy_session_overview' ||
    (row.family == null && row.scope === 'session')
  ) {
    family = 'legacy_session_overview';
  }
  const [sessionId] = sessions;
  return {
    nodeId: String(row.id),
    family,
    ...(sessions.size === 1 && sessionId !== undefined ? { sessionId } : {}),
    ...(typeof row.published_by === 'string' ? { publicationOperationId: row.published_by } : {}),
    ...(typeof row.retired_by === 'string' ? { retirementOperationId: row.retired_by } : {}),
  };
}

/** Structural identity only. The application adapter alone interprets the retirement marker. */
export function findNarrativeFamilyIdentities(
  driver: Driver,
  ids: readonly string[],
): Promise<readonly NarrativeFamilyIdentity[]> {
  return ids.length === 0
    ? Promise.resolve([])
    : runRead(driver, IDENTITIES, { ids: [...ids] }, identity);
}

export function readNarrativeFamilyIdentities(
  tx: GraphTransaction,
  ids: readonly string[],
): Promise<readonly NarrativeFamilyIdentity[]> {
  return ids.length === 0 ? Promise.resolve([]) : tx.run(IDENTITIES, { ids: [...ids] }, identity);
}

const LEGACY = `n.${NARRATIVE_PROPERTIES.scope} = 'session'
  AND (n.${NARRATIVE_PROPERTIES.family} IS NULL OR n.${NARRATIVE_PROPERTIES.family} = 'legacy_session_overview')`;
const SESSION = `(n.${MEMORY_PROPERTIES.sessionId} = $sessionId
  OR EXISTS { (n)-[:${DERIVES_FROM_TYPE}]->(:Session {id: $sessionId}) })`;

export async function hasNarrativeSession(
  tx: GraphTransaction,
  sessionId: string,
): Promise<boolean> {
  const rows = await tx.run(
    'MATCH (s:Session {id: $sessionId}) RETURN s.id AS id LIMIT 1',
    { sessionId },
    (row) => String(row.id),
  );
  return rows.length === 1;
}
const LEGACY_HEADS = [
  'MATCH (n:Narrative)',
  `WHERE ${SESSION} AND ${LEGACY} AND ${currentOnly('n')}`,
  'RETURN n.id AS id ORDER BY n.id LIMIT $limit',
].join('\n');

/** An absorbed or superseded legacy version still makes this an existing narrative family. */
export async function hasLegacyNarrativeHistory(
  tx: GraphTransaction,
  sessionId: string,
): Promise<boolean> {
  const rows = await tx.run(
    `MATCH (n:Narrative) WHERE ${SESSION} AND ${LEGACY} RETURN n.id AS id LIMIT 1`,
    { sessionId },
    (row) => String(row.id),
  );
  return rows.length === 1;
}

/** The bounded standing set a cutover binds, without choosing an arbitrary winner. */
export function readLegacyHeads(
  tx: GraphTransaction,
  sessionId: string,
  limit: number,
): Promise<readonly string[]> {
  return tx.run(LEGACY_HEADS, { sessionId, limit: toGraphInteger(limit) }, (row) => String(row.id));
}

export function findLegacyHeads(
  driver: Driver,
  sessionId: string,
  limit: number,
): Promise<readonly string[]> {
  return runRead(driver, LEGACY_HEADS, { sessionId, limit: toGraphInteger(limit) }, (row) =>
    String(row.id),
  );
}

/** Global inventory also reaches orphaned versions whose session has no surviving source record. */
export function pageLegacyNarrativeIdentities(
  driver: Driver,
  after: string,
  limit: number,
): Promise<readonly NarrativeFamilyIdentity[]> {
  return runRead(
    driver,
    [
      'MATCH (n:Narrative)',
      `WHERE ${LEGACY} AND n.id > $after`,
      'WITH n ORDER BY n.id LIMIT $limit',
      `OPTIONAL MATCH (n)-[:${DERIVES_FROM_TYPE}]->(s:Session)`,
      `RETURN n.id AS id, n.${MEMORY_PROPERTIES.sessionId} AS session_id, collect(DISTINCT s.id) AS sessions,`,
      `  n.${NARRATIVE_PROPERTIES.family} AS family, n.${NARRATIVE_PROPERTIES.scope} AS scope,`,
      `  n.${REPRESENTATION_RETIRED_BY} AS retired_by ORDER BY id`,
    ].join('\n'),
    { after, limit: toGraphInteger(limit) },
    identity,
  );
}

export type LegacyNarrativeInventory = {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly sourceIds: readonly string[];
  readonly citations: readonly string[];
  readonly citationCount: number;
  readonly coverageKey: string;
  readonly coverageCount: number;
  readonly originalKnownFrom: string | null;
};

/** Reads the complete source set or one sentinel beyond the caller's proof bound. */
export async function readLegacyNarrativeInventory(
  tx: GraphTransaction,
  input: { readonly sessionId: string; readonly nodeId: string; readonly memberLimit: number },
): Promise<LegacyNarrativeInventory | undefined> {
  const rows = await tx.run(
    [
      'MATCH (n:Narrative {id: $nodeId})',
      `WHERE ${SESSION} AND ${LEGACY}`,
      'CALL { WITH n',
      `  MATCH (e:Episode)-[:${SUMMARIZED_BY_TYPE}]->(n)`,
      '  WITH DISTINCT e.id AS id ORDER BY id LIMIT $memberLimit',
      '  RETURN collect(id) AS members',
      '}',
      `RETURN n.id AS id, coalesce(n.${MEMORY_PROPERTIES.sessionId}, $sessionId) AS session_id, members,`,
      `       n.${NARRATIVE_PROPERTIES.citations}[..$memberLimit] AS citations,`,
      `       size(n.${NARRATIVE_PROPERTIES.citations}) AS citation_count,`,
      `       n.${NARRATIVE_PROPERTIES.coverageKey} AS coverage_key,`,
      `       n.${NARRATIVE_PROPERTIES.coverageCount} AS coverage_count, n.tx_from AS original_known_from`,
    ].join('\n'),
    { ...input, memberLimit: toGraphInteger(input.memberLimit) },
    (row) => ({
      nodeId: String(row.id),
      sessionId: String(row.session_id),
      sourceIds: Array.isArray(row.members) ? (row.members as string[]) : [],
      citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
      citationCount: typeof row.citation_count === 'number' ? row.citation_count : -1,
      coverageKey: typeof row.coverage_key === 'string' ? row.coverage_key : '',
      coverageCount: typeof row.coverage_count === 'number' ? row.coverage_count : -1,
      originalKnownFrom: fromGraphDateTime(row.original_known_from)?.toISOString() ?? null,
    }),
  );
  return rows[0];
}

/** Tags only the representation family. Every recorded world/knowledge/content field stays intact. */
export async function tagLegacyNarratives(
  tx: GraphTransaction,
  sessionId: string,
  ids: readonly string[],
  retirementOperationId?: string,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const rows = await tx.run(
    [
      'MATCH (n:Narrative)',
      `WHERE n.id IN $ids AND ${SESSION} AND ${LEGACY}`,
      `  AND ($retirement IS NULL OR n.${REPRESENTATION_RETIRED_BY} IS NULL OR n.${REPRESENTATION_RETIRED_BY} = $retirement)`,
      `SET n.${NARRATIVE_PROPERTIES.family} = 'legacy_session_overview'`,
      `FOREACH (_ IN CASE WHEN $retirement IS NULL THEN [] ELSE [1] END | SET n.${REPRESENTATION_RETIRED_BY} = $retirement)`,
      'RETURN n.id AS id ORDER BY n.id',
    ].join('\n'),
    { sessionId, ids: [...ids], retirement: retirementOperationId ?? null },
    (row) => String(row.id),
  );
  if (JSON.stringify([...rows].sort()) !== JSON.stringify([...ids].sort())) {
    throw new Error('legacy representation changed before its family marker was written');
  }
}

/** The original clock of each bounded legacy head, copied under the family publication guard. */
export function readLegacyOriginalClocks(
  tx: GraphTransaction,
  nodeIds: readonly string[],
): Promise<readonly { nodeId: string; originalKnownFrom: string | null }[]> {
  return tx.run(
    'MATCH (n:Narrative) WHERE n.id IN $nodeIds RETURN n.id AS id, n.tx_from AS original',
    { nodeIds: [...nodeIds] },
    (row) => ({
      nodeId: String(row.id),
      originalKnownFrom: fromGraphDateTime(row.original)?.toISOString() ?? null,
    }),
  );
}
