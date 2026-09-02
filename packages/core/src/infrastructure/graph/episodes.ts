import neo4j, { type Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphTransaction } from './connection.js';
import { readModeFragment, withCurrency, type ReadMode } from './read-modes.js';

/**
 * Property names shared between the writer in `core/reflection/` and the Cypher here, so
 * a rename cannot drift the two apart. `content_vec` is the property migration 001's
 * vector index is declared on, and `text`/`summary` are two of the three the `content_fts`
 * fulltext index covers: a memory node written under other names is invisible to both.
 */
export const MEMORY_PROPERTIES = {
  text: 'text',
  summary: 'summary',
  role: 'role',
  sequence: 'sequence',
  contentHash: 'content_hash',
  contentVector: 'content_vec',
  /** sha256 of the exact text `content_vec` was taken over. Absent means the vector is pending. */
  contentVectorHash: 'content_vec_hash',
  sessionId: 'session_id',
  sourceEpisodeId: 'source_episode_id',
  extractionMethod: 'extraction_method',
  turnCount: 'turn_count',
  toolExecutionCount: 'tool_execution_count',
  observationCount: 'observation_count',
  /** Record-only: how the reflection call that wrote this episode reached intake. */
  originChannel: 'origin_channel',
  originEvent: 'origin_event',
  /**
   * Provenance stamped at intake from the node's own fingerprints, absent when the node's
   * text held no secret. What separates a residue scan's "cleaned" from "never dirty".
   */
  redactionRules: 'redaction_rules',
  redactionSpanCount: 'redaction_span_count',
} as const;

/** `PARTICIPATES_IN` is member-to-container for Turn→Episode and Episode→Session alike. */
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

export type StoredEpisodeRef = {
  readonly id: string;
  readonly sessionId: string | undefined;
};

/**
 * Every episode the substrate holds, newest first, for reconciliation against the ops ledger
 * and the queue. Superseded episodes are included and forgotten ones are not: a corrected
 * episode still deserves enrichment, an explicitly forgotten one never will.
 *
 * Newest first because that is the order the answer matters in: an episode written minutes
 * ago and never enqueued is a live freshness bug, one from last month is history. This
 * makes `limit` cut the tail rather than the head.
 */
const LIST_STORED_EPISODES = [
  'MATCH (e:Episode)',
  `WHERE e.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `RETURN e.id AS id, e.${MEMORY_PROPERTIES.sessionId} AS session_id`,
  `ORDER BY e.${BITEMPORAL_PROPERTIES.txFrom} DESC, e.id`,
  'LIMIT $limit',
].join('\n');

export async function listStoredEpisodes(
  driver: Driver,
  limit: number,
): Promise<readonly StoredEpisodeRef[]> {
  return runRead(driver, LIST_STORED_EPISODES, { limit: neo4j.int(Math.trunc(limit)) }, (row) => ({
    id: row.id as string,
    sessionId: typeof row.session_id === 'string' ? row.session_id : undefined,
  }));
}

/**
 * One session's own episode ids, for a caller that must answer "how many of mine are still
 * unenriched" without pulling every episode's text (`loadSessionEpisodes` in
 * `narrative-queries.ts` does that for compression; this is the id-only reader for a check
 * run on every recall). Respects `mode` so a bitemporal read sees the episode set that
 * existed at that vantage point.
 */
function sessionEpisodeIdsStatement(
  sessionId: string,
  mode: ReadMode,
): { cypher: string; parameters: Record<string, unknown> } {
  const episode = readModeFragment(mode, 'e', 'rme');
  const cypher = [
    `MATCH (e:Episode)-[:${CONTAINMENT_TYPE}]->(:Session { id: $sessionId })`,
    `WHERE ${episode.where}`,
    'RETURN e.id AS id',
  ].join('\n');
  return { cypher, parameters: { sessionId, ...episode.parameters } };
}

export async function listSessionEpisodeIds(
  driver: Driver,
  sessionId: string,
  mode: ReadMode = withCurrency(),
): Promise<readonly string[]> {
  const statement = sessionEpisodeIdsStatement(sessionId, mode);
  return runRead(driver, statement.cypher, statement.parameters, (row) => row.id as string);
}
