import type { ReflectionOrigin } from '@aion/protocol';
import { createHash, randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';

/** The archive envelope's shape. Bumped only when a column's meaning changes. */
export const ARCHIVE_SCHEMA_VERSION = 1;

export type ExperienceArchiveRow = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly schemaVersion: number;
  readonly pipelineVersion: string;
  readonly identity: string;
  readonly sessionId: string;
  readonly episodeId: string;
  readonly contentHash: string;
  readonly occurredAt: string;
  readonly archivedAt: string;
  readonly lane: string | undefined;
  readonly origin: ReflectionOrigin | undefined;
  readonly payload: ReflectionContent;
};

export type ExperienceArchiveInput = {
  readonly schemaVersion: number;
  readonly pipelineVersion: string;
  readonly identity: string;
  readonly sessionId: string;
  readonly episodeId: string;
  readonly contentHash: string;
  readonly occurredAt: string;
  readonly archivedAt: string;
  readonly lane?: string;
  readonly origin?: ReflectionOrigin;
  readonly payload: ReflectionContent;
};

/** Where a keyset page left off: the last row's `(occurred_at, id)`, oldest first. */
export type ExperienceArchiveCursor = {
  readonly occurredAt: string;
  readonly id: string;
};

export type ExperienceArchiveFilter = {
  /** Selects rows archived under any other pipeline version; omit to select every row. */
  readonly excludePipelineVersion?: string;
  readonly episodeId?: string;
  readonly sessionId?: string;
};

/** The oldest and newest experience the archive holds, by the clock the episodes happened on. */
export type ExperienceArchiveSpan = {
  readonly oldestOccurredAt: string;
  readonly newestOccurredAt: string;
};

type ExperienceArchiveRowData = {
  id: string;
  idempotency_key: string;
  schema_version: number;
  pipeline_version: string;
  identity: string;
  session_id: string;
  episode_id: string;
  content_hash: string;
  occurred_at: string;
  archived_at: string;
  lane: string | null;
  origin_json: string | null;
  payload_json: string;
};

function toExperienceArchiveRow(row: ExperienceArchiveRowData): ExperienceArchiveRow {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    schemaVersion: row.schema_version,
    pipelineVersion: row.pipeline_version,
    identity: row.identity,
    sessionId: row.session_id,
    episodeId: row.episode_id,
    contentHash: row.content_hash,
    occurredAt: row.occurred_at,
    archivedAt: row.archived_at,
    lane: row.lane ?? undefined,
    origin:
      row.origin_json === null ? undefined : (JSON.parse(row.origin_json) as ReflectionOrigin),
    payload: JSON.parse(row.payload_json) as ReflectionContent,
  };
}

/**
 * sha256 over the identity, the content hash and the schema version, with a separator no
 * field can contain. Folding identity in keeps two sessions' identical content as two
 * archive rows, matching the graph's own per-session dedup grain rather than collapsing them
 * into one.
 */
export function experienceArchiveKey(
  identity: string,
  contentHash: string,
  schemaVersion: number,
): string {
  const parts = [identity, contentHash, String(schemaVersion)];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Inserts one archive row, or nothing at all: the conflict target is the idempotency key, and
 * a conflict is a no-op, never a rewrite. Returns whether the row was new, which is what lets
 * a caller tell a first archive of an experience from a re-push of one already held.
 */
export function insertExperience(db: SqliteHandle, input: ExperienceArchiveInput): boolean {
  const key = experienceArchiveKey(input.identity, input.contentHash, input.schemaVersion);
  const row = db
    .prepare(
      `INSERT INTO experience_archive
         (id, idempotency_key, schema_version, pipeline_version, identity, session_id,
          episode_id, content_hash, occurred_at, archived_at, lane, origin_json, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING id`,
    )
    .get(
      randomUUID(),
      key,
      input.schemaVersion,
      input.pipelineVersion,
      input.identity,
      input.sessionId,
      input.episodeId,
      input.contentHash,
      input.occurredAt,
      input.archivedAt,
      input.lane ?? null,
      input.origin === undefined ? null : JSON.stringify(input.origin),
      JSON.stringify(input.payload),
    ) as { id: string } | undefined;
  return row !== undefined;
}

/**
 * The archive row for one episode, ordered by insertion so a caller reaches the row that
 * first recorded it if more than one archive write ever named the same episode.
 */
export function getExperienceByEpisode(
  db: SqliteHandle,
  episodeId: string,
): ExperienceArchiveRow | undefined {
  const row = db
    .prepare('SELECT * FROM experience_archive WHERE episode_id = ? ORDER BY rowid ASC LIMIT 1')
    .get(episodeId) as ExperienceArchiveRowData | undefined;
  return row === undefined ? undefined : toExperienceArchiveRow(row);
}

/**
 * A page of rows ordered oldest first by `(occurred_at, id)`, the pair the replay indexes on.
 * `cursor` is the last row of the previous page, or `undefined` for the first page; passing
 * the last row returned back in as the next cursor visits every row exactly once even as a
 * multi-batch run is aborted and resumed between them.
 */
export function listExperiencesAfter(
  db: SqliteHandle,
  cursor: ExperienceArchiveCursor | undefined,
  limit: number,
  filter: ExperienceArchiveFilter = {},
): readonly ExperienceArchiveRow[] {
  const clauses: string[] = [];
  const parameters: unknown[] = [];

  if (cursor !== undefined) {
    clauses.push('(occurred_at > ? OR (occurred_at = ? AND id > ?))');
    parameters.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
  }
  if (filter.excludePipelineVersion !== undefined) {
    clauses.push('pipeline_version <> ?');
    parameters.push(filter.excludePipelineVersion);
  }
  if (filter.episodeId !== undefined) {
    clauses.push('episode_id = ?');
    parameters.push(filter.episodeId);
  }
  if (filter.sessionId !== undefined) {
    clauses.push('session_id = ?');
    parameters.push(filter.sessionId);
  }

  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
  const rows = db
    .prepare(
      `SELECT * FROM experience_archive ${where}
       ORDER BY occurred_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...parameters, limit) as ExperienceArchiveRowData[];
  return rows.map(toExperienceArchiveRow);
}

/**
 * A random handful of experiences that happened before `before`, for a caller measuring the
 * substrate against what it was told rather than walking the whole archive. Random rather than
 * the keyset page above: a fixed page measures the same few experiences forever, and a retrieval
 * rate read off three rows that never change says nothing about the rest of the substrate.
 */
export function sampleExperiencesBefore(
  db: SqliteHandle,
  before: string,
  limit: number,
): readonly ExperienceArchiveRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM experience_archive WHERE occurred_at < ?
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(before, limit) as ExperienceArchiveRowData[];
  return rows.map(toExperienceArchiveRow);
}

/**
 * How far back the archive reaches, or `undefined` when it holds nothing. Both stamps are
 * world time, so the span says which experiences a replay covers rather than when they were
 * archived.
 */
export function experienceArchiveSpan(db: SqliteHandle): ExperienceArchiveSpan | undefined {
  const row = db
    .prepare(
      `SELECT MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest FROM experience_archive`,
    )
    .get() as { oldest: string | null; newest: string | null } | undefined;
  if (row?.oldest == null || row.newest == null) {
    return undefined;
  }
  return { oldestOccurredAt: row.oldest, newestOccurredAt: row.newest };
}

/** How many archived rows sit under each pipeline version, for `aion replay ls`'s summary. */
export function countExperiencesByVersion(
  db: SqliteHandle,
): readonly { readonly version: string; readonly count: number }[] {
  return db
    .prepare(
      `SELECT pipeline_version AS version, COUNT(*) AS count
       FROM experience_archive
       GROUP BY pipeline_version
       ORDER BY pipeline_version ASC`,
    )
    .all() as { version: string; count: number }[];
}
