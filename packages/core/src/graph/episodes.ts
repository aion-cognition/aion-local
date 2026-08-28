import type { Driver } from 'neo4j-driver';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphTransaction } from './connection.js';

/**
 * Property names shared between the writer in `core/reflection/` and the Cypher here, so
 * a rename cannot drift the two apart. `content_vec` is the property migration 001's
 * vector index is declared on, and `text`/`summary` are two of the three the `content_fts`
 * fulltext index covers — a memory node written under other names is invisible to both.
 */
export const MEMORY_PROPERTIES = {
  text: 'text',
  summary: 'summary',
  role: 'role',
  sequence: 'sequence',
  contentHash: 'content_hash',
  contentVector: 'content_vec',
  sessionId: 'session_id',
  sourceEpisodeId: 'source_episode_id',
  extractionMethod: 'extraction_method',
  turnCount: 'turn_count',
  toolExecutionCount: 'tool_execution_count',
  observationCount: 'observation_count',
} as const;

/** Whitepaper Appendix C: `PARTICIPATES_IN` is member-to-container for Turn→Episode and Episode→Session alike. */
export const CONTAINMENT_TYPE = 'PARTICIPATES_IN';

export type FindEpisodeByContentHashInput = {
  readonly sessionId: string;
  readonly contentHash: string;
};

/**
 * The dedupe window is one session, so the match anchors on `Session.id` (uniqueness
 * constrained, therefore an index seek) and expands into that session's episodes rather
 * than scanning every Episode in the graph for a hash no index covers. Earliest write
 * wins, which is what makes a re-pushed payload resolve to the original episode instead
 * of whichever duplicate the planner happened to reach first.
 */
const FIND_EPISODE_BY_CONTENT_HASH = [
  `MATCH (:Session { id: $sessionId })<-[:${CONTAINMENT_TYPE}]-(e:Episode)`,
  `WHERE e.${MEMORY_PROPERTIES.contentHash} = $contentHash`,
  `RETURN e.id AS id ORDER BY e.${BITEMPORAL_PROPERTIES.txFrom}, e.id LIMIT 1`,
].join('\n');

function contentHashParameters(input: FindEpisodeByContentHashInput): Record<string, unknown> {
  return { sessionId: input.sessionId, contentHash: input.contentHash };
}

export async function findEpisodeByContentHash(
  driver: Driver,
  input: FindEpisodeByContentHashInput,
): Promise<string | undefined> {
  const rows = await runRead(
    driver,
    FIND_EPISODE_BY_CONTENT_HASH,
    contentHashParameters(input),
    (row) => row.id as string,
  );
  return rows[0];
}

/**
 * The same read inside a caller's transaction. Intake uses this one: outside a transaction
 * that holds the session's lock, the answer is stale the instant it returns, because a peer
 * may be writing the very episode it looked for.
 */
export async function findEpisodeByContentHashInTransaction(
  tx: GraphTransaction,
  input: FindEpisodeByContentHashInput,
): Promise<string | undefined> {
  const rows = await tx.run(
    FIND_EPISODE_BY_CONTENT_HASH,
    contentHashParameters(input),
    (row) => row.id as string,
  );
  return rows[0];
}
