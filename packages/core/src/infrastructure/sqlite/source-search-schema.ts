/**
 * The archive search projection: one document per captured part, the full-text index over
 * those documents, and the cursor each indexing stream has reached.
 *
 * These are derived projections rather than witnesses. Nothing here is evidence: the parts are
 * C1's, the bytes are the archive's, and a row in this table is only an address the search can
 * nominate. Every hit is resolved through the evidence resolver and re-checked for disclosure
 * before a caller sees any of it.
 */

/** The policy a document was indexed under. A change here makes every stored document stale. */
export const INDEX_POLICY_VERSION = 1;

/** UTF-8 bytes of one part that may be indexed. A longer part keeps a prefix and says so. */
export const INDEX_MAX_PART_BYTES = 1024 * 1024;

/** Parts and indexed bytes one job run may spend, whichever bound arrives first. */
export const INDEX_BATCH_PARTS = 100;
export const INDEX_BATCH_BYTES = 1024 * 1024;

/** The name the virtual table carries, referenced by the store's MATCH statements. */
export const SOURCE_SEARCH_FTS_TABLE = 'source_search_fts';

/**
 * The two ordinary tables, applied on every open like the rest of the schema. The virtual
 * table is deliberately absent: creating it needs a capability this binary may not have, and a
 * failure there would take every other database user down with it.
 */
export const SOURCE_SEARCH_SCHEMA_STATEMENTS: readonly string[] = [
  /**
   * One row per captured part, keyed on C1's part address. `content_digest` and
   * `index_policy_version` together decide whether a stored document still describes the part,
   * which is what makes a repeated indexing run a no-op rather than a rewrite.
   *
   * `truncated` and `indexed_bytes` are what a hit discloses about its own coverage: a part
   * longer than the cap keeps its longest valid UTF-8 prefix, so a phrase past that prefix is
   * absent from the index while the archive still holds it.
   */
  `CREATE TABLE IF NOT EXISTS source_search_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    part_kind TEXT NOT NULL,
    part_ordinal INTEGER NOT NULL CHECK (part_ordinal >= 0),
    content_digest TEXT NOT NULL,
    index_policy_version INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
    indexed_bytes INTEGER NOT NULL CHECK (indexed_bytes >= 0),
    UNIQUE (source_id, part_kind, part_ordinal)
  )`,
  /**
   * Where each indexing stream has reached. `generation` is the projection's own version: every
   * replacement of an existing document increments it in the replacement's transaction, so a
   * paginating reader that comes back to a changed projection is told to restart rather than
   * handed a page assembled from two different corpora. Pure appends never touch it, because an
   * appended document is above the reader's own upper bound and cannot enter its page.
   *
   * The live stream's row carries that number for the whole projection. A registry of
   * outstanding cursors would be the alternative, and there is no such registry: an existing
   * document necessarily sits at or below the pre-transaction high-water mark, which is the
   * bound that replaces the unknowable maximum outstanding cursor.
   */
  `CREATE TABLE IF NOT EXISTS source_search_progress (
    stream TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    index_policy_version INTEGER NOT NULL,
    state TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)
  )`,
];

export const SOURCE_SEARCH_INDEX_STATEMENTS: readonly string[] = [
  // The coverage and pin reads, both of which ask about one source's documents.
  `CREATE INDEX IF NOT EXISTS source_search_documents_source_idx
     ON source_search_documents (source_id, part_kind, part_ordinal)`,
  // Incomplete corpus coverage, which every search discloses. Partial, so the scan costs what
  // the truncated set is rather than what the corpus holds.
  `CREATE INDEX IF NOT EXISTS source_search_documents_truncated_idx
     ON source_search_documents (source_id) WHERE truncated = 1`,
];

/**
 * The virtual table, created only behind a verified capability probe. `rowid` is the document
 * row's own id, so a nomination is an address lookup rather than a second identity.
 */
export const SOURCE_SEARCH_FTS_STATEMENT = `CREATE VIRTUAL TABLE IF NOT EXISTS ${SOURCE_SEARCH_FTS_TABLE} USING fts5(body)`;
