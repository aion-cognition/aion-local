import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead, type GraphTransaction } from './connection.js';
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
  // Legacy only. A chunk revision carries its own family key and is grouped on that instead;
  // two chunks of one session are two memories, not two versions of one, and a sweep that kept
  // grouping this way would close one of them against the other.
  `WHERE ${currentOnly('n')} AND n.${NARRATIVE_PROPERTIES.chunkId} IS NULL`,
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

const READ_OPEN_NARRATIVE_VERSIONS = [
  `MATCH (n:Narrative)-[:${DERIVES_FROM_TYPE}]->(:Session { id: $sessionId })`,
  `WHERE ${currentOnly('n')}`,
  `RETURN n.id AS id, n.${NARRATIVE_PROPERTIES.version} AS version,`,
  `       n.${NARRATIVE_PROPERTIES.coverageCount} AS coverage_count`,
  'ORDER BY n.id',
].join('\n');

/**
 * The same group re-read inside the caller's transaction, after the session lock. The scan that
 * found the duplicates ran outside any lock, so by the time the closes are written another
 * writer may have closed the version this run picked to keep, and closing the rest against it
 * would leave the session with no current narrative at all.
 *
 * No caller left: the duplicate close it re-read for is gone. The statement is kept because the
 * lock-ordering rule it exists for outlives the caller, and a replacement would rewrite it.
 */
export async function readOpenNarrativeVersionsInTransaction(
  tx: GraphTransaction,
  sessionId: string,
): Promise<DuplicateNarrativeVersion[]> {
  return tx.run(READ_OPEN_NARRATIVE_VERSIONS, { sessionId }, (row) => ({
    id: row.id as string,
    version: typeof row.version === 'number' ? row.version : 0,
    coverageCount: typeof row.coverage_count === 'number' ? row.coverage_count : 0,
  }));
}

export type ChunkRevisionVersion = {
  readonly id: string;
  readonly revisionNo: number;
};

export type DuplicateChunkFamily = {
  readonly chunkId: string;
  readonly versions: readonly ChunkRevisionVersion[];
};

/**
 * The duplicate group for a chunk is the chunk itself, and never the session it came out of.
 *
 * A session serves several distinct chunks at once by design, so grouping on the session made
 * every one of them a duplicate of the others and left the run to pick a survivor by coverage
 * count. Grouping on `chunk_id` cannot make that mistake: two nodes are candidates only when they
 * are two revisions of one frozen membership, and which of them stands is a manifest fact the
 * caller reads rather than a property of the prose.
 */
const FIND_DUPLICATE_CHUNK_FAMILIES = [
  'MATCH (n:Narrative)',
  `WHERE ${currentOnly('n')} AND n.${NARRATIVE_PROPERTIES.chunkId} IS NOT NULL`,
  `  AND ($after = '' OR n.${NARRATIVE_PROPERTIES.chunkId} > $after)`,
  `WITH n.${NARRATIVE_PROPERTIES.chunkId} AS chunk_id,`,
  `     collect({ id: n.id, revision_no: n.${NARRATIVE_PROPERTIES.revisionNo} }) AS all_versions`,
  'WHERE size(all_versions) > 1',
  // The version array is truncated in the query, so what the page RETURNS is bounded whatever the
  // family holds. The collect above still builds the whole array server-side, so this is a bound on
  // the returned records and on what the caller materializes, and not a bound on server memory.
  // What the caller does with a page is choose a family; the repair re-reads that family's standing
  // revisions under the guard and bounds its own reading, so a truncated page loses no correctness.
  'WITH chunk_id, all_versions[0..$versionLimit] AS versions',
  'RETURN chunk_id, versions',
  'ORDER BY chunk_id',
  'LIMIT $limit',
].join('\n');

function readChunkVersion(value: unknown): ChunkRevisionVersion {
  const row = (value ?? {}) as Row;
  return {
    id: (row.id as string | null) ?? '',
    revisionNo: typeof row.revision_no === 'number' ? row.revision_no : 0,
  };
}

export type DuplicateFamilyPage = {
  readonly limit: number;
  /** Standing versions returned per family, which is what bounds the materialized records. */
  readonly versionLimit: number;
  /** Resume strictly past this family key, so an unrepairable prefix stops holding the front. */
  readonly after?: string;
};

export async function findDuplicateChunkFamilies(
  driver: Driver,
  page: DuplicateFamilyPage,
): Promise<DuplicateChunkFamily[]> {
  if (page.limit <= 0 || page.versionLimit <= 0) {
    return [];
  }
  return runRead(
    driver,
    {
      cypher: FIND_DUPLICATE_CHUNK_FAMILIES,
      parameters: {
        limit: toGraphInteger(page.limit),
        versionLimit: toGraphInteger(page.versionLimit),
        after: page.after ?? '',
      },
    },
    (row) => ({
      chunkId: row.chunk_id as string,
      versions: Array.isArray(row.versions) ? row.versions.map(readChunkVersion) : [],
    }),
  );
}

const READ_STANDING_FAMILY_NODES = [
  `MATCH (n:Narrative { ${NARRATIVE_PROPERTIES.chunkId}: $chunkId })`,
  `WHERE ${currentOnly('n')} AND n.id IN $nodeIds`,
  'RETURN n.id AS id',
].join('\n');

/**
 * Which of the NAMED nodes are standing revisions of this family, read inside a caller's lock.
 *
 * The question a repair asks, in the direction the records answer it. Enumerating the family's
 * standing nodes and testing each against the manifest makes the answer depend on how the family's
 * other ids happen to sort: a page of ids the manifest binds to nothing hides every legitimate
 * target behind it, and a cursor over families cannot step inside one. Naming the candidates makes
 * the graph decide only what it is the authority on — which of these still stands.
 */
export async function standingFamilyNodesInTransaction(
  tx: GraphTransaction,
  chunkId: string,
  nodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (nodeIds.length === 0) {
    return new Set();
  }
  const rows = await tx.run(READ_STANDING_FAMILY_NODES, { chunkId, nodeIds: [...nodeIds] }, (row) =>
    String(row.id),
  );
  return new Set(rows);
}

const READ_STANDING_FAMILY_NODE = [
  `MATCH (n:Narrative { ${NARRATIVE_PROPERTIES.chunkId}: $chunkId })`,
  `WHERE ${currentOnly('n')} AND n.id = $nodeId`,
  'RETURN n.id AS id',
].join('\n');

/**
 * Whether ONE named node is a standing revision of this family.
 *
 * The keeper is named by the manifest, so proving it stands is a question about that one node.
 * Asking it of a bounded page instead makes the answer depend on how the family's other ids happen
 * to sort, and a keeper the page did not reach reads as a keeper that does not exist.
 */
export async function standsInFamilyInTransaction(
  tx: GraphTransaction,
  chunkId: string,
  nodeId: string,
): Promise<boolean> {
  const rows = await tx.run(READ_STANDING_FAMILY_NODE, { chunkId, nodeId }, (row) =>
    String(row.id),
  );
  return rows.length > 0;
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
