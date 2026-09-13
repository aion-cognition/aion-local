import type { Driver } from 'neo4j-driver';

import { runRead, type GraphTransaction } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { DERIVES_FROM_TYPE, NARRATIVE_PROPERTIES } from './narrative-queries.js';
import { fromGraphDateTime, type Row } from './values.js';

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

/** Publication identity, so a reader can tell which publication minted a narrative version. */
export const NARRATIVE_PUBLISHED_BY = 'narrative_published_by';

/** Representation retirement names its publication; the canonical time belongs to that ACK. */
export const REPRESENTATION_RETIRED_BY = 'representation_retired_by';

export type NarrativeFamilyIdentity = {
  readonly nodeId: string;
  readonly sessionId?: string;
  readonly family: 'chunk' | 'overview' | 'unknown';
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
  const family: NarrativeFamilyIdentity['family'] =
    row.family === 'chunk' || row.family === 'overview' ? row.family : 'unknown';
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
