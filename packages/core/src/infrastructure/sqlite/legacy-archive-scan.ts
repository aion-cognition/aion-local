import type { SqliteHandle } from './database.js';
import type { SourceRecordInput } from './source-identity.js';

/**
 * The read half of the legacy backfill: walking the archive inside the frozen bounds and
 * working out what each episode's source occurrence looks like.
 *
 * Nothing here claims verification. Proving a source faithful means comparing its content
 * against the graph, and this side has only the archive, so it produces candidates and the
 * reasons they are not yet settled. A group whose archive rows disagree with each other is
 * pinned outright: an ambiguity is recorded, never resolved by picking a side.
 */
export type ArchiveScanRow = {
  /** The scan position. The cursor a restart resumes from is the last one of the previous page. */
  readonly rowid: number;
  readonly archiveId: string;
  readonly sessionId: string;
  readonly episodeId: string;
  readonly contentHash: string;
  readonly identityHash: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly archivedAt: string;
};

type ArchiveRowData = {
  rowid: number;
  id: string;
  session_id: string;
  episode_id: string;
  content_hash: string;
  idempotency_key: string;
  schema_version: number;
  occurred_at: string;
  archived_at: string;
};

function toScanRow(row: ArchiveRowData): ArchiveScanRow {
  return {
    rowid: row.rowid,
    archiveId: row.id,
    sessionId: row.session_id,
    episodeId: row.episode_id,
    contentHash: row.content_hash,
    identityHash: row.idempotency_key,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    archivedAt: row.archived_at,
  };
}

/** The bounds a freeze captures, and how many rows sit inside them. */
export function archiveRowidBounds(db: SqliteHandle): {
  low: number;
  high: number;
  rows: number;
} {
  const row = db
    .prepare(
      'SELECT COALESCE(MIN(rowid), 0) AS low, COALESCE(MAX(rowid), 0) AS high, count(*) AS rows FROM experience_archive',
    )
    .get() as { low: number; high: number; rows: number };
  return { low: row.low, high: row.high, rows: row.rows };
}

export type ArchivePageRequest = {
  readonly low: number;
  readonly high: number;
  /** The last rowid of the previous page, or nothing for the first one. */
  readonly cursor?: number;
  readonly limit: number;
};

/**
 * A bounded page of archive rows, oldest first by rowid. Paging on the key rather than an
 * offset is what lets an aborted pass resume without skipping a row or reading one twice.
 */
export function pageArchiveRows(
  db: SqliteHandle,
  request: ArchivePageRequest,
): readonly ArchiveScanRow[] {
  const rows = db
    .prepare(
      `SELECT rowid, id, session_id, episode_id, content_hash, idempotency_key, schema_version,
              occurred_at, archived_at
       FROM experience_archive
       WHERE rowid >= ? AND rowid <= ? AND rowid > ?
       ORDER BY rowid LIMIT ?`,
    )
    .all(request.low, request.high, request.cursor ?? 0, request.limit) as ArchiveRowData[];
  return rows.map(toScanRow);
}

/**
 * Every archive row inside the frozen bounds that backs one episode.
 *
 * The bounds are part of the question. A row written after the freeze belongs to the tail cohort
 * and answering with it here would let the walk verify a member against bytes its own census
 * never counted.
 */
export function pageArchiveRowsForEpisode(
  db: SqliteHandle,
  episodeId: string,
  bounds: { readonly low: number; readonly high: number },
): readonly ArchiveScanRow[] {
  const rows = db
    .prepare(
      `SELECT rowid, id, session_id, episode_id, content_hash, idempotency_key, schema_version,
              occurred_at, archived_at
       FROM experience_archive
       WHERE episode_id = ? AND rowid >= ? AND rowid <= ?
       ORDER BY rowid`,
    )
    .all(episodeId, bounds.low, bounds.high) as ArchiveRowData[];
  return rows.map(toScanRow);
}

/**
 * Every archive row that backs one source: the ones its own episode id names, and the canonical
 * row its record already points at.
 *
 * A later occurrence of the same bytes has no archive row of its own — the archive is keyed on the
 * content, so the first occurrence's row is the one both records were verified against. Looking
 * only by episode id would report that occurrence as unarchived and pin a source whose canonical
 * mapping is written down.
 */
export function archiveGroupFor(
  db: SqliteHandle,
  sourceId: string,
  canonicalArchiveId: string | null,
  bounds: { readonly low: number; readonly high: number },
): ArchiveSourceGroup | undefined {
  const rows = [...pageArchiveRowsForEpisode(db, sourceId, bounds)];
  if (canonicalArchiveId !== null && !rows.some((row) => row.archiveId === canonicalArchiveId)) {
    const named = db
      .prepare(
        `SELECT rowid, id, session_id, episode_id, content_hash, idempotency_key, schema_version,
                occurred_at, archived_at
         FROM experience_archive
         WHERE id = ? AND rowid >= ? AND rowid <= ?`,
      )
      .get(canonicalArchiveId, bounds.low, bounds.high) as ArchiveRowData | undefined;
    if (named !== undefined) {
      rows.push(toScanRow(named));
    }
  }
  if (rows.length === 0) {
    return undefined;
  }
  const canonical = rows.reduce(earlier);
  return {
    // The source being verified, not whichever occurrence happened to write the archive row.
    sourceId,
    sessionId: canonical.sessionId,
    canonicalArchiveId: canonical.archiveId,
    aliasArchiveIds: rows
      .filter((row) => row.archiveId !== canonical.archiveId)
      .map((row) => row.archiveId)
      .sort(),
    contentHash: canonical.contentHash,
    identityHash: canonical.identityHash,
    schemaVersion: canonical.schemaVersion,
    occurredAt: canonical.occurredAt,
    archivedAt: canonical.archivedAt,
    conflictingAliases: rows.some((row) => row.contentHash !== canonical.contentHash),
  };
}

export type ArchiveSourceGroup = {
  readonly sourceId: string;
  readonly sessionId: string;
  /** The earliest archive row for this episode, chosen the same way on every run. */
  readonly canonicalArchiveId: string;
  readonly aliasArchiveIds: readonly string[];
  readonly contentHash: string;
  readonly identityHash: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly archivedAt: string;
  /** True when the rows disagree about the content, which is what pins the source. */
  readonly conflictingAliases: boolean;
};

function earlier(left: ArchiveScanRow, right: ArchiveScanRow): ArchiveScanRow {
  if (left.archivedAt === right.archivedAt) {
    return left.archiveId <= right.archiveId ? left : right;
  }
  return left.archivedAt < right.archivedAt ? left : right;
}

/**
 * Groups a page of archive rows into one candidate per episode. Several archive rows of one
 * episode are one source with aliases, never several sources, and the canonical row is picked
 * by a fixed rule so a restart produces the same grouping.
 */
export function groupArchiveRowsBySource(
  rows: readonly ArchiveScanRow[],
): readonly ArchiveSourceGroup[] {
  const byEpisode = new Map<string, ArchiveScanRow[]>();
  for (const row of rows) {
    const group = byEpisode.get(row.episodeId);
    if (group === undefined) {
      byEpisode.set(row.episodeId, [row]);
    } else {
      group.push(row);
    }
  }

  return [...byEpisode.entries()].map(([episodeId, group]) => {
    const canonical = group.reduce(earlier);
    const aliases = group
      .filter((row) => row.archiveId !== canonical.archiveId)
      .map((row) => row.archiveId)
      .sort();
    return {
      sourceId: episodeId,
      sessionId: canonical.sessionId,
      canonicalArchiveId: canonical.archiveId,
      aliasArchiveIds: aliases,
      contentHash: canonical.contentHash,
      identityHash: canonical.identityHash,
      schemaVersion: canonical.schemaVersion,
      occurredAt: canonical.occurredAt,
      archivedAt: canonical.archivedAt,
      conflictingAliases: group.some((row) => row.contentHash !== canonical.contentHash),
    };
  });
}

/**
 * The source record a group implies before anything has checked it against the graph. The
 * status is never 'verified' here: this side has no graph to verify against, so it says what
 * it is waiting on, and a group whose rows disagree says that instead.
 */
export function deriveSourceRecordInput(
  group: ArchiveSourceGroup,
  createdAt: Date,
): SourceRecordInput {
  return {
    sourceId: group.sourceId,
    sessionId: group.sessionId,
    verificationStatus: group.conflictingAliases ? 'pinned' : 'unresolved',
    verificationReason: group.conflictingAliases
      ? 'archive rows for this episode disagree about its content'
      : 'content not yet checked against the graph',
    occurredAt: group.occurredAt,
    createdAt,
    captureOrderValue: group.archivedAt,
    captureOrderBasis: 'archive_acceptance',
  };
}

/**
 * The same group once the graph has agreed with it: the complete archive proof, including the
 * alias rows that back the same occurrence.
 *
 * Only a caller that has compared the stored digest against the graph's own may build this. The
 * table's CHECK is what makes `verified` mean something, and every field of the proof is present
 * here or the row is refused rather than half-claimed.
 */
export function verifiedSourceRecordInput(
  group: ArchiveSourceGroup,
  input: { readonly verificationPolicyVersion: number; readonly createdAt: Date },
): SourceRecordInput {
  return {
    sourceId: group.sourceId,
    sessionId: group.sessionId,
    verificationStatus: 'verified',
    occurredAt: group.occurredAt,
    createdAt: input.createdAt,
    archive: {
      canonicalArchiveId: group.canonicalArchiveId,
      archiveSchemaVersion: group.schemaVersion,
      identityHash: group.identityHash,
      verifiedContentDigest: group.contentHash,
      verificationPolicyVersion: input.verificationPolicyVersion,
      archivedAt: group.archivedAt,
      aliasArchiveIds: group.aliasArchiveIds,
    },
    captureOrderValue: group.archivedAt,
    captureOrderBasis: 'archive_acceptance',
  };
}
