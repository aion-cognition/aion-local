import neo4j, { type Driver } from 'neo4j-driver';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import type { RelationshipType } from './relationships.js';
import { toGraphDateTime, type Row } from './values.js';

/**
 * Whitepaper §6.10. The three reads narrative compression needs: the episodes a session
 * accumulated, the narrative versions it already carries, and the sessions that have gone
 * quiet. The node and its edges are written through the ordinary stamped-node and
 * edge-upsert adapters, so nothing here writes.
 */

/**
 * Beyond the base stamp and `summary`/`text`/`session_id`, which every memory node shares.
 * `coverage_key` is the identity of the episode set this narrative compresses — it is the
 * idempotency key of the whole operation, held on the node rather than in a side table, and
 * the narrative's own id is derived from it.
 */
export const NARRATIVE_PROPERTIES = {
  scope: 'scope',
  version: 'version',
  /** Fraction of the covered episodes that actually reached the model. */
  coverage: 'coverage',
  coverageKey: 'coverage_key',
  coverageCount: 'coverage_count',
  spanStart: 'span_start',
  spanEnd: 'span_end',
} as const;

/**
 * Appendix C directions, chosen to read as English: an episode is summarized by the
 * narrative, `(Episode)-[:SUMMARIZED_BY]->(Narrative)`, and the narrative derives from the
 * session it compresses, `(Narrative)-[:DERIVES_FROM]->(Session)`. Both are in the protected
 * relationship set, so decay and pruning never touch them.
 */
export const SUMMARIZED_BY_TYPE: RelationshipType = 'SUMMARIZED_BY';
export const DERIVES_FROM_TYPE: RelationshipType = 'DERIVES_FROM';

/** A session accumulates versions one at a time; reading fifty back covers any real history. */
const NARRATIVE_VERSION_LIMIT = 50;

export type SessionEpisode = {
  readonly id: string;
  readonly text: string;
  readonly summary?: string;
  readonly occurredAt?: Date;
  /** System time of the write, which is what "the session went quiet" is measured against. */
  readonly writtenAt?: Date;
};

export type SessionNarrative = {
  readonly id: string;
  readonly version: number;
  readonly coverageKey: string;
  readonly coverageCount: number;
  /** `valid_until` absent: this version has not been superseded by a later one. */
  readonly open: boolean;
};

export type IdleSession = {
  readonly sessionId: string;
  readonly lastActivityAt: Date;
  readonly episodeCount: number;
};

/** Procedure arguments and `LIMIT` are Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

function asOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

/**
 * Superseded episodes stay in the set: a fact the substrate later corrected is still part of
 * what happened in the session. Only an explicit forget removes an episode from its
 * narrative, which is the default read mode's own rule.
 */
function sessionEpisodesStatement(sessionId: string): GraphStatement {
  const episode = readModeFragment(withCurrency(), 'e', 'rme');
  const cypher = [
    `MATCH (e:Episode)-[:${CONTAINMENT_TYPE}]->(:Session { id: $sessionId })`,
    `WHERE ${episode.where}`,
    'RETURN',
    '  e.id AS id,',
    `  e.${MEMORY_PROPERTIES.text} AS text,`,
    `  e.${MEMORY_PROPERTIES.summary} AS summary,`,
    `  e.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at,`,
    `  e.${BITEMPORAL_PROPERTIES.txFrom} AS tx_from`,
    `ORDER BY e.${BITEMPORAL_PROPERTIES.occurredAt}, e.${BITEMPORAL_PROPERTIES.txFrom}, e.id`,
  ].join('\n');

  return { cypher, parameters: { sessionId, ...episode.parameters } };
}

function readSessionEpisode(row: Row): SessionEpisode {
  const summary = asOptionalText(row.summary);
  const occurredAt = asDate(row.occurred_at);
  const writtenAt = asDate(row.tx_from);
  return {
    id: row.id as string,
    text: typeof row.text === 'string' ? row.text : '',
    ...(summary === undefined ? {} : { summary }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(writtenAt === undefined ? {} : { writtenAt }),
  };
}

/** In the order they happened, so compression reads the session as an arc rather than a set. */
export async function loadSessionEpisodes(
  driver: Driver,
  sessionId: string,
): Promise<SessionEpisode[]> {
  const statement = sessionEpisodesStatement(sessionId);
  return runRead(driver, statement.cypher, statement.parameters, readSessionEpisode);
}

/**
 * Every version the session carries, newest first, each marked open or superseded. The
 * currency read fragment is deliberately not used: the versioning decision turns on whether
 * `supersede()` has closed a version, which is a fact about the node, not a judgment
 * relative to some reference time.
 */
const FIND_SESSION_NARRATIVES = [
  `MATCH (n:Narrative)-[:${DERIVES_FROM_TYPE}]->(:Session { id: $sessionId })`,
  `WHERE n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  'RETURN',
  '  n.id AS id,',
  `  n.${NARRATIVE_PROPERTIES.version} AS version,`,
  `  n.${NARRATIVE_PROPERTIES.coverageKey} AS coverage_key,`,
  `  n.${NARRATIVE_PROPERTIES.coverageCount} AS coverage_count,`,
  `  n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AS open`,
  `ORDER BY n.${NARRATIVE_PROPERTIES.version} DESC, n.id`,
  'LIMIT $limit',
].join('\n');

function readSessionNarrative(row: Row): SessionNarrative {
  return {
    id: row.id as string,
    version: typeof row.version === 'number' ? row.version : 0,
    coverageKey: typeof row.coverage_key === 'string' ? row.coverage_key : '',
    coverageCount: typeof row.coverage_count === 'number' ? row.coverage_count : 0,
    open: row.open === true,
  };
}

export async function findSessionNarratives(
  driver: Driver,
  sessionId: string,
): Promise<SessionNarrative[]> {
  return runRead(
    driver,
    FIND_SESSION_NARRATIVES,
    { sessionId, limit: toGraphInteger(NARRATIVE_VERSION_LIMIT) },
    readSessionNarrative,
  );
}

export type IdleSessionInput = {
  /** Sessions whose last write landed at or before this instant are idle. */
  readonly idleBefore: Date;
  readonly limit: number;
};

/**
 * Sessions that have gone quiet and whose newest open narrative does not already cover every
 * episode they hold. Filtering the covered ones out inside the query is what keeps a sweep
 * bounded by `limit` from returning the same settled sessions forever and starving the ones
 * that actually need compressing.
 *
 * Idleness is measured on `tx_from`, the moment the substrate heard from the session, not on
 * `occurred_at`, which the caller supplies and may backdate arbitrarily.
 */
const FIND_IDLE_SESSIONS = [
  `MATCH (e:Episode)-[:${CONTAINMENT_TYPE}]->(s:Session)`,
  `WHERE e.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `WITH s, max(e.${BITEMPORAL_PROPERTIES.txFrom}) AS last_activity, count(e) AS episode_count`,
  'WHERE last_activity <= $idleBefore',
  `OPTIONAL MATCH (n:Narrative)-[:${DERIVES_FROM_TYPE}]->(s)`,
  `WHERE n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL AND n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  `WITH s, last_activity, episode_count, max(n.${NARRATIVE_PROPERTIES.coverageCount}) AS covered`,
  'WHERE covered IS NULL OR covered < episode_count',
  'RETURN s.id AS session_id, last_activity, episode_count',
  'ORDER BY last_activity, s.id',
  'LIMIT $limit',
].join('\n');

export async function findIdleSessions(
  driver: Driver,
  input: IdleSessionInput,
): Promise<IdleSession[]> {
  if (input.limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    FIND_IDLE_SESSIONS,
    {
      idleBefore: toGraphDateTime(input.idleBefore),
      limit: toGraphInteger(input.limit),
    },
    (row) => ({
      sessionId: row.session_id as string,
      lastActivityAt: asDate(row.last_activity) ?? input.idleBefore,
      episodeCount: typeof row.episode_count === 'number' ? row.episode_count : 0,
    }),
  );
}
