import type { SqliteHandle } from './database.js';
import { readSourceParts } from './source-identity.js';
import { INDEX_POLICY_VERSION, SOURCE_SEARCH_FTS_TABLE } from './source-search-schema.js';

/**
 * Reads and writes over the search projection. Every write here is a projection write: no row
 * in these tables is evidence about a source, and nothing a reader finds here is disclosed
 * before the evidence resolver has answered for it.
 */

/** The stream an ordinary acceptance indexes under, and whose row holds the generation. */
export const LIVE_INDEX_STREAM = 'live';

/** The resumable cohort pass, which keeps its own cursor and shares the generation. */
export const MIGRATION_INDEX_STREAM = 'migration';

export type SearchDocument = {
  readonly id: number;
  readonly sourceId: string;
  readonly partKind: string;
  readonly partOrdinal: number;
  readonly contentDigest: string;
  readonly indexPolicyVersion: number;
  readonly truncated: boolean;
  readonly indexedBytes: number;
};

type DocumentRow = {
  id: number;
  source_id: string;
  part_kind: string;
  part_ordinal: number;
  content_digest: string;
  index_policy_version: number;
  truncated: number;
  indexed_bytes: number;
};

function toDocument(row: DocumentRow): SearchDocument {
  return {
    id: row.id,
    sourceId: row.source_id,
    partKind: row.part_kind,
    partOrdinal: row.part_ordinal,
    contentDigest: row.content_digest,
    indexPolicyVersion: row.index_policy_version,
    truncated: row.truncated === 1,
    indexedBytes: row.indexed_bytes,
  };
}

export type SearchDocumentInput = {
  readonly sourceId: string;
  readonly partKind: string;
  readonly partOrdinal: number;
  readonly contentDigest: string;
  /** The indexed text, already cut to its longest valid prefix within `INDEX_MAX_PART_BYTES`. */
  readonly body: string;
  readonly truncated: boolean;
  /** UTF-8 bytes of `body`, which is what the batch bound and the coverage disclosure count. */
  readonly indexedBytes: number;
};

export function readSearchDocument(
  db: SqliteHandle,
  sourceId: string,
  partKind: string,
  partOrdinal: number,
): SearchDocument | undefined {
  const row = db
    .prepare(
      `SELECT * FROM source_search_documents
       WHERE source_id = ? AND part_kind = ? AND part_ordinal = ?`,
    )
    .get(sourceId, partKind, partOrdinal) as DocumentRow | undefined;
  return row === undefined ? undefined : toDocument(row);
}

export function listSearchDocumentsForSource(
  db: SqliteHandle,
  sourceId: string,
): readonly SearchDocument[] {
  const rows = db
    .prepare(
      `SELECT * FROM source_search_documents WHERE source_id = ?
       ORDER BY part_kind, part_ordinal`,
    )
    .all(sourceId) as DocumentRow[];
  return rows.map(toDocument);
}

/** The greatest document id in the projection, which is a search's upper watermark. */
export function documentHighWater(db: SqliteHandle): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(id), 0) AS high FROM source_search_documents')
    .get() as { high: number } | undefined;
  return row?.high ?? 0;
}

/**
 * The projection's generation, held on the live stream's row. A substrate that has never
 * indexed anything reads as generation 1, which is what a first cursor binds against.
 */
export function searchGeneration(db: SqliteHandle): number {
  const row = db
    .prepare('SELECT generation FROM source_search_progress WHERE stream = ?')
    .get(LIVE_INDEX_STREAM) as { generation: number } | undefined;
  return row?.generation ?? 1;
}

export type IndexProgress = {
  readonly stream: string;
  readonly cursor: string;
  readonly indexPolicyVersion: number;
  readonly state: string;
  readonly generation: number;
};

export function readIndexProgress(db: SqliteHandle, stream: string): IndexProgress | undefined {
  const row = db.prepare('SELECT * FROM source_search_progress WHERE stream = ?').get(stream) as
    | {
        stream: string;
        cursor: string;
        index_policy_version: number;
        state: string;
        generation: number;
      }
    | undefined;
  return row === undefined
    ? undefined
    : {
        stream: row.stream,
        cursor: row.cursor,
        indexPolicyVersion: row.index_policy_version,
        state: row.state,
        generation: row.generation,
      };
}

/**
 * Where a stream has reached, written without touching the generation. The cursor is the part
 * address the run stopped after, so a restart resumes rather than re-reading the source.
 */
export function recordIndexProgress(
  db: SqliteHandle,
  input: { readonly stream: string; readonly cursor: string; readonly state: string },
): void {
  db.prepare(
    `INSERT INTO source_search_progress (stream, cursor, index_policy_version, state, generation)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (stream) DO UPDATE SET
       cursor = excluded.cursor,
       index_policy_version = excluded.index_policy_version,
       state = excluded.state`,
  ).run(input.stream, input.cursor, INDEX_POLICY_VERSION, input.state);
}

/** The live row, minted at generation 1 so a bump has something to increment. */
function ensureLiveStream(db: SqliteHandle): void {
  db.prepare(
    `INSERT INTO source_search_progress (stream, cursor, index_policy_version, state, generation)
     VALUES (?, '', ?, 'idle', 1)
     ON CONFLICT (stream) DO NOTHING`,
  ).run(LIVE_INDEX_STREAM, INDEX_POLICY_VERSION);
}

export type DocumentWrite = 'appended' | 'replaced' | 'unchanged';

/** Whether the stored document still says what this reading of the part says, in every field. */
function describesPart(stored: SearchDocument, input: SearchDocumentInput): boolean {
  return (
    stored.contentDigest === input.contentDigest &&
    stored.indexPolicyVersion === INDEX_POLICY_VERSION &&
    stored.truncated === input.truncated &&
    stored.indexedBytes === input.indexedBytes
  );
}

/**
 * One document written, with its body and its metadata in one transaction.
 *
 * A document that already exists and whose digest and policy still describe the part is left
 * exactly as it is, which is what makes a retry idempotent. A document that has to change is
 * replaced and the projection's generation is incremented in the same transaction, because a
 * reader paginating over the old body would otherwise assemble one page out of two corpora.
 * An appended document never bumps it: it sits above every outstanding reader's watermark.
 *
 * A part longer than the index cap arrives here already cut; the caller owns the cut because
 * only the caller knows the whole part it came from.
 */
export function writeSearchDocument(db: SqliteHandle, input: SearchDocumentInput): DocumentWrite {
  return db
    .transaction((): DocumentWrite => {
      const existing = readSearchDocument(db, input.sourceId, input.partKind, input.partOrdinal);
      if (existing !== undefined && describesPart(existing, input)) {
        return 'unchanged';
      }
      ensureLiveStream(db);
      if (existing !== undefined) {
        db.prepare(`DELETE FROM ${SOURCE_SEARCH_FTS_TABLE} WHERE rowid = ?`).run(existing.id);
        db.prepare(
          `UPDATE source_search_documents
             SET content_digest = ?, index_policy_version = ?, truncated = ?, indexed_bytes = ?
           WHERE id = ?`,
        ).run(
          input.contentDigest,
          INDEX_POLICY_VERSION,
          input.truncated ? 1 : 0,
          input.indexedBytes,
          existing.id,
        );
        db.prepare(`INSERT INTO ${SOURCE_SEARCH_FTS_TABLE} (rowid, body) VALUES (?, ?)`).run(
          existing.id,
          input.body,
        );
        db.prepare(
          'UPDATE source_search_progress SET generation = generation + 1 WHERE stream = ?',
        ).run(LIVE_INDEX_STREAM);
        return 'replaced';
      }
      const inserted = db
        .prepare(
          `INSERT INTO source_search_documents
             (source_id, part_kind, part_ordinal, content_digest, index_policy_version,
              truncated, indexed_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sourceId,
          input.partKind,
          input.partOrdinal,
          input.contentDigest,
          INDEX_POLICY_VERSION,
          input.truncated ? 1 : 0,
          input.indexedBytes,
        );
      db.prepare(`INSERT INTO ${SOURCE_SEARCH_FTS_TABLE} (rowid, body) VALUES (?, ?)`).run(
        inserted.lastInsertRowid,
        input.body,
      );
      return 'appended';
    })
    .immediate();
}

export type NominationRequest = {
  /** The FTS5 expression the grammar built. Never a caller's own text. */
  readonly matchExpression: string;
  /** The document id the previous page stopped after; nothing when this is a first page. */
  readonly afterId: number;
  /** The high-water mark this search is bound to. A later document belongs to a fresh search. */
  readonly upperBound: number;
  /** How many documents this call may examine, which the cursor advances over. */
  readonly limit: number;
};

/**
 * The bounded set of addresses a query nominates, in document-id order.
 *
 * The order is the stored id and not a relevance score: a live BM25 value is not stable across
 * pages, and paginating on one would silently drop or repeat rows as the corpus moves. Ranking
 * is a separate change, and this order is what makes a continuation mean something.
 */
export function nominateDocuments(
  db: SqliteHandle,
  request: NominationRequest,
): readonly SearchDocument[] {
  const rows = db
    .prepare(
      `SELECT d.* FROM ${SOURCE_SEARCH_FTS_TABLE} f
       JOIN source_search_documents d ON d.id = f.rowid
       WHERE ${SOURCE_SEARCH_FTS_TABLE} MATCH ? AND d.id > ? AND d.id <= ?
       ORDER BY d.id
       LIMIT ?`,
    )
    .all(
      request.matchExpression,
      request.afterId,
      request.upperBound,
      request.limit,
    ) as DocumentRow[];
  return rows.map(toDocument);
}

export type CorpusCoverage = {
  readonly documents: number;
  /** Documents holding a prefix of their part, so a phrase past that prefix cannot be found. */
  readonly truncatedDocuments: number;
};

/**
 * What the corpus can and cannot answer for, disclosed on every search including one that
 * matched nothing: a suffix miss and an empty corpus read identically from the results alone.
 */
export function corpusCoverage(db: SqliteHandle): CorpusCoverage {
  const row = db
    .prepare(
      `SELECT count(*) AS documents,
              COALESCE(sum(truncated), 0) AS truncated
       FROM source_search_documents`,
    )
    .get() as { documents: number; truncated: number };
  return { documents: row.documents, truncatedDocuments: row.truncated };
}

export type SearchIndexPin =
  | { readonly pinned: false }
  | {
      readonly pinned: true;
      readonly reason: 'truncated_parts' | 'unindexed_parts';
      readonly parts: number;
    };

/**
 * Whether the projection still owes this source something, which is what holds it against
 * eviction. A truncated document means the index never held the whole part; a recorded part
 * with no document means indexing has not reached it. Either way the raw bytes are the only
 * complete copy, and removing them would make the missing text unreachable.
 *
 * A later complete reindex clears the pin by replacing the documents, never by asserting
 * coverage: the pin is read from the rows, so it lifts when the rows say it may.
 */
export function searchIndexPin(db: SqliteHandle, sourceId: string): SearchIndexPin {
  const truncated = db
    .prepare(
      'SELECT count(*) AS n FROM source_search_documents WHERE source_id = ? AND truncated = 1',
    )
    .get(sourceId) as { n: number };
  if (truncated.n > 0) {
    return { pinned: true, reason: 'truncated_parts', parts: truncated.n };
  }
  const recorded = readSourceParts(db, sourceId).length;
  const indexed = db
    .prepare(
      `SELECT count(*) AS n FROM source_search_documents
       WHERE source_id = ? AND index_policy_version = ?`,
    )
    .get(sourceId, INDEX_POLICY_VERSION) as { n: number };
  return recorded > indexed.n
    ? { pinned: true, reason: 'unindexed_parts', parts: recorded - indexed.n }
    : { pinned: false };
}
