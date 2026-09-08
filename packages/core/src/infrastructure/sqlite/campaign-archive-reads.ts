import type { SqliteHandle } from './database.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';

/**
 * Read-only measurements over the stored archive: how large the records are and how many
 * parts each one carries.
 *
 * Sizes come from the stored bytes rather than from re-serializing the decoded payload. A
 * round trip through the decoder normalizes key order and whitespace, so a size read that way
 * describes what this process would write, not what the substrate is holding, and a proposed
 * limit checked against it would be checked against the wrong number.
 *
 * Every read here pages on `(occurred_at, id)`, the same keyset the replay walks, so an
 * interrupted measurement resumes where it stopped.
 */

export type ArchiveRecordShape = {
  readonly id: string;
  readonly episodeId: string;
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly pipelineVersion: string;
  /** UTF-8 bytes of the stored payload column, envelope and all. */
  readonly payloadBytes: number;
  readonly turnCount: number;
  readonly observationCount: number;
  readonly toolExecutionCount: number;
};

export type ArchiveShapeCursor = {
  readonly occurredAt: string;
  readonly id: string;
};

type ShapeRowData = {
  id: string;
  episode_id: string;
  session_id: string;
  occurred_at: string;
  pipeline_version: string;
  payload_bytes: number;
  payload_json: string;
};

function partCounts(
  payloadJson: string,
): Pick<ArchiveRecordShape, 'turnCount' | 'observationCount' | 'toolExecutionCount'> {
  const payload = JSON.parse(payloadJson) as ReflectionContent;
  return {
    turnCount: payload.turns?.length ?? 0,
    observationCount: payload.observations?.length ?? 0,
    toolExecutionCount: payload.tool_executions?.length ?? 0,
  };
}

/**
 * One page of record shapes, oldest first. `cursor` is the last row of the previous page.
 * `CAST(... AS BLOB)` is what makes `length` count bytes: on a text column it counts
 * characters, and a payload holding anything outside ASCII would then read short.
 */
export function readArchiveShapePage(
  db: SqliteHandle,
  cursor: ArchiveShapeCursor | undefined,
  limit: number,
): readonly ArchiveRecordShape[] {
  const where =
    cursor === undefined ? '' : 'WHERE (occurred_at > ? OR (occurred_at = ? AND id > ?))';
  const parameters = cursor === undefined ? [] : [cursor.occurredAt, cursor.occurredAt, cursor.id];
  const rows = db
    .prepare(
      `SELECT id, episode_id, session_id, occurred_at, pipeline_version,
              length(CAST(payload_json AS BLOB)) AS payload_bytes, payload_json
       FROM experience_archive ${where}
       ORDER BY occurred_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...parameters, limit) as ShapeRowData[];

  return rows.map((row) => ({
    id: row.id,
    episodeId: row.episode_id,
    sessionId: row.session_id,
    occurredAt: row.occurred_at,
    pipelineVersion: row.pipeline_version,
    payloadBytes: row.payload_bytes,
    ...partCounts(row.payload_json),
  }));
}

export type ArchiveCensus = {
  readonly rows: number;
  readonly episodes: number;
  readonly sessions: number;
  readonly identities: number;
};

/** How much the archive holds, counted four ways, so a row count is never read as an episode count. */
export function readArchiveCensus(db: SqliteHandle): ArchiveCensus {
  const row = db
    .prepare(
      `SELECT count(*) AS rows,
              count(DISTINCT episode_id) AS episodes,
              count(DISTINCT session_id) AS sessions,
              count(DISTINCT identity) AS identities
       FROM experience_archive`,
    )
    .get() as ArchiveCensus | undefined;
  return row ?? { rows: 0, episodes: 0, sessions: 0, identities: 0 };
}

export type UsageEventCensus = {
  readonly rows: number;
  readonly oldestOccurredAt?: string;
  readonly newestOccurredAt?: string;
};

/**
 * The use record's own bounds, kept apart from the archive's: the two tables answer different
 * questions and a cost interval taken over one is not an interval over the other.
 */
export function readUsageEventCensus(db: SqliteHandle): UsageEventCensus {
  const row = db
    .prepare(
      `SELECT count(*) AS rows, min(occurred_at) AS oldest, max(occurred_at) AS newest
       FROM usage_events`,
    )
    .get() as { rows: number; oldest: string | null; newest: string | null } | undefined;
  if (row === undefined) {
    return { rows: 0 };
  }
  return {
    rows: row.rows,
    ...(row.oldest === null ? {} : { oldestOccurredAt: row.oldest }),
    ...(row.newest === null ? {} : { newestOccurredAt: row.newest }),
  };
}

export type ApiCallCensus = {
  readonly rows: number;
  readonly oldestOccurredAt?: string;
  readonly newestOccurredAt?: string;
  /** Calls whose billed token counts failed to parse, which is what makes a cost total partial. */
  readonly usageErrors: number;
};

/**
 * The cost meter's bounds and its error count. A cost interval reported without the error
 * count reads as complete, and a meter that failed to parse a response is exactly the case
 * where the total is understated.
 */
export function readApiCallCensus(db: SqliteHandle): ApiCallCensus {
  const row = db
    .prepare(
      `SELECT count(*) AS rows, min(occurred_at) AS oldest, max(occurred_at) AS newest,
              sum(CASE WHEN usage_error IS NOT NULL THEN 1 ELSE 0 END) AS usage_errors
       FROM api_calls`,
    )
    .get() as
    | { rows: number; oldest: string | null; newest: string | null; usage_errors: number | null }
    | undefined;
  if (row === undefined) {
    return { rows: 0, usageErrors: 0 };
  }
  return {
    rows: row.rows,
    usageErrors: row.usage_errors ?? 0,
    ...(row.oldest === null ? {} : { oldestOccurredAt: row.oldest }),
    ...(row.newest === null ? {} : { newestOccurredAt: row.newest }),
  };
}
