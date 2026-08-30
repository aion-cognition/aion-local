import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead } from './connection.js';
import { CONTAINMENT_TYPE } from './episodes.js';
import { DERIVES_FROM_TYPE, NARRATIVE_PROPERTIES } from './narrative-queries.js';
import { toGraphInteger, type Row } from './values.js';

/**
 * The two structural pathologies `narrative_cleanup` repairs without a model call. Duplicates
 * are two open narratives left standing after a crash landed between a write and its
 * supersession; `decideSessionNarrative`'s own repair path closes a straggler the next time
 * something calls `narrateSession` for its session, but a session that never closes again (no
 * new episode, no idle sweep reaching it) can carry the pair indefinitely. Orphans are open
 * narratives whose session no longer holds a single live episode to have grounded them: every
 * episode that could justify the claim was later forgotten.
 */

export type DuplicateNarrativeVersion = {
  readonly id: string;
  readonly version: number;
  readonly coverageCount: number;
};

export type DuplicateNarrativeGroup = {
  readonly sessionId: string;
  readonly versions: readonly DuplicateNarrativeVersion[];
};

const FIND_DUPLICATE_NARRATIVE_SESSIONS = [
  `MATCH (n:Narrative)-[:${DERIVES_FROM_TYPE}]->(s:Session)`,
  `WHERE ${currentOnly('n')}`,
  `WITH s, collect({ id: n.id, version: n.${NARRATIVE_PROPERTIES.version},` +
    ` coverage_count: n.${NARRATIVE_PROPERTIES.coverageCount} }) AS versions`,
  'WHERE size(versions) > 1',
  'RETURN s.id AS session_id, versions',
  'ORDER BY s.id',
  'LIMIT $limit',
].join('\n');

function readVersion(value: unknown): DuplicateNarrativeVersion {
  const row = (value ?? {}) as Row;
  return {
    id: (row.id as string | null) ?? '',
    version: typeof row.version === 'number' ? row.version : 0,
    coverageCount: typeof row.coverage_count === 'number' ? row.coverage_count : 0,
  };
}

/**
 * Sessions currently carrying more than one open narrative, each with the versions that are
 * open. Bounded by session count, not narrative count: a session with three duplicates still
 * costs one slot of `limit`.
 */
export async function findDuplicateNarrativeSessions(
  driver: Driver,
  limit: number,
): Promise<DuplicateNarrativeGroup[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    { cypher: FIND_DUPLICATE_NARRATIVE_SESSIONS, parameters: { limit: toGraphInteger(limit) } },
    (row) => ({
      sessionId: row.session_id as string,
      versions: Array.isArray(row.versions) ? row.versions.map(readVersion) : [],
    }),
  );
}

export type OrphanedNarrative = {
  readonly id: string;
  readonly sessionId: string;
};

const FIND_ORPHANED_NARRATIVES = [
  `MATCH (n:Narrative)-[:${DERIVES_FROM_TYPE}]->(s:Session)`,
  `WHERE ${currentOnly('n')}`,
  '  AND NOT EXISTS {',
  `    MATCH (e:Episode)-[:${CONTAINMENT_TYPE}]->(s)`,
  `    WHERE e.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  '  }',
  'RETURN n.id AS id, s.id AS session_id',
  'ORDER BY s.id, n.id',
  'LIMIT $limit',
].join('\n');

export async function findOrphanedNarratives(
  driver: Driver,
  limit: number,
): Promise<OrphanedNarrative[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    { cypher: FIND_ORPHANED_NARRATIVES, parameters: { limit: toGraphInteger(limit) } },
    (row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
    }),
  );
}
