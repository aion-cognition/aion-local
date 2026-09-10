import type { ColumnAddition } from './column-additions.js';

/**
 * The narrative manifest: which sources sealed into which chunk, what revisions each family
 * has allocated, which one is published, and what a published revision cited. Two families
 * live here, chunks and calendar overviews, and they carry the same revision columns so one
 * write helper serves both.
 */
export const NARRATIVE_SCHEMA_STATEMENTS: readonly string[] = [
  /**
   * A chunk is a sealed set of sources under one partition policy. `published_revision_no` is
   * the head: null until a first publication lands, and moved only by one that succeeds.
   *
   * `overlaps_json` is F13 D6's annotation: the earlier chunks of this session whose world-time
   * span contains ANY of this one's members. A backdated arrival joins the remainder and seals
   * into a later chunk rather than repartitioning history, so the overlap is the only record that
   * the two describe the same stretch of time. Null and empty differ as they do everywhere here:
   * null means nobody computed it, an empty array means it was computed and there was none.
   *
   * `overlaps_truncated` is what keeps a bounded read from reading as a survey: set when the seal
   * found more overlapping chunks than its limit stores, so a later reader knows the list names
   * some of them rather than all of them.
   */
  `CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    partition_policy_version INTEGER NOT NULL,
    state TEXT NOT NULL,
    sealed_at TEXT NOT NULL,
    published_revision_no INTEGER,
    member_count INTEGER NOT NULL CHECK (member_count > 0),
    created_at TEXT NOT NULL,
    overlaps_json TEXT,
    overlaps_truncated INTEGER
  )`,
  /**
   * Frozen membership. A source seals into exactly one chunk and never moves, which is what
   * `UNIQUE (source_id)` says; ordinals are unique inside a chunk so the member order is a
   * fact rather than a tie-break.
   */
  `CREATE TABLE IF NOT EXISTS chunk_members (
    chunk_id TEXT NOT NULL,
    source_id TEXT NOT NULL UNIQUE,
    member_ordinal INTEGER NOT NULL CHECK (member_ordinal >= 0),
    PRIMARY KEY (chunk_id, source_id),
    UNIQUE (chunk_id, member_ordinal)
  )`,
  /**
   * One row per allocated revision of a chunk. The row is durable before any provider work
   * starts, so an abandoned attempt leaves a gap in the numbering rather than a number that
   * gets handed out twice.
   *
   * `coverage_gaps_json` distinguishes three states and null is not one of them by accident:
   * null means nobody has established what the synthesis saw, an empty array means the input
   * was verified complete, and a populated array binds the submitted ranges and the reason to
   * this revision. Offsets in it are UTF-16 code units, which is what string indexing here
   * counts.
   *
   * The four attempt columns schedule a retry of this revision rather than of the source
   * behind it. `blocked_reason` takes the row out of nomination until a prerequisite changes;
   * `next_attempt_at` moves it later without taking it out.
   *
   * `claim_expires_at` is ownership, not scheduling, which is why it is its own column: a live
   * attempt holds its number until that moment, and a claim that never returns strands nothing
   * past it. Writing the lease into `next_attempt_at` conflates the two — the nomination reads
   * that column to decide which CHUNKS a run may try, so a lease there stalls a reconsidered
   * block behind a claim nobody is holding.
   *
   * `attempt_policy_json` records the bounds the attempt actually ran under. A block on a bound
   * clears when the bound changes, and a detector comparing the current policy to the one that
   * refused needs the second number as much as the first.
   */
  `CREATE TABLE IF NOT EXISTS chunk_revisions (
    chunk_id TEXT NOT NULL,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    node_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    operation_id TEXT,
    evidence_revision_json TEXT,
    allocated_at TEXT NOT NULL,
    known_from TEXT,
    observed_ack_at TEXT,
    published_at TEXT,
    closed_at TEXT,
    coverage_gaps_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT,
    blocked_reason TEXT,
    last_failure_reason TEXT,
    attempt_policy_json TEXT,
    claim_expires_at TEXT,
    PRIMARY KEY (chunk_id, revision_no)
  )`,
  /**
   * The overview family's head and high-water, kept apart. A publication moves
   * `published_revision_no`; an allocation moves `allocated_high_water` whether or not it ever
   * publishes. The CHECK is what stops a head from pointing past what was ever allocated.
   */
  `CREATE TABLE IF NOT EXISTS overview_registry (
    family_key TEXT PRIMARY KEY,
    published_revision_no INTEGER,
    allocated_high_water INTEGER NOT NULL DEFAULT 0 CHECK (allocated_high_water >= 0),
    CHECK (published_revision_no IS NULL
        OR (published_revision_no > 0 AND published_revision_no <= allocated_high_water))
  )`,
  /**
   * Overview revisions, column for column the same contract as chunk revisions so the shared
   * helper reads and writes both without a special case. `family_key` names the window an
   * overview covers, as '(scope kind):(window key)'.
   */
  `CREATE TABLE IF NOT EXISTS overview_revisions (
    family_key TEXT NOT NULL,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    node_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    operation_id TEXT,
    evidence_revision_json TEXT,
    allocated_at TEXT NOT NULL,
    known_from TEXT,
    observed_ack_at TEXT,
    published_at TEXT,
    closed_at TEXT,
    coverage_gaps_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT,
    blocked_reason TEXT,
    last_failure_reason TEXT,
    attempt_policy_json TEXT,
    claim_expires_at TEXT,
    PRIMARY KEY (family_key, revision_no)
  )`,
  /**
   * Scope to the narrative revisions that depend on it, keyed on the revision's own graph node
   * id. Keying on the node rather than on a chunk is what lets an overview depend on another
   * overview: an invalidation chain resolves without inventing a chunk for a level that has
   * none. Rows are written when the revision is acknowledged.
   */
  `CREATE TABLE IF NOT EXISTS revision_dependencies (
    endpoint_id TEXT NOT NULL,
    relation_class TEXT NOT NULL,
    narrative_node_id TEXT NOT NULL,
    version_token TEXT NOT NULL,
    PRIMARY KEY (endpoint_id, relation_class, narrative_node_id)
  )`,
  /**
   * What a published revision cited, for every target kind. A part is addressed as
   * `part:<source_id>:<part_kind>:<ordinal>`, so two observation parts of one source stay two
   * citation targets instead of collapsing into the source id they share.
   */
  `CREATE TABLE IF NOT EXISTS revision_citations (
    narrative_node_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    PRIMARY KEY (narrative_node_id, target_id, target_kind)
  )`,
  /**
   * Which representation a session serves, as an append-only log of cutovers rather than a
   * flag. A read at some past moment needs to know what was selected then, and a flag only
   * knows what is selected now.
   */
  `CREATE TABLE IF NOT EXISTS family_selection_log (
    session_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    active_family TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    PRIMARY KEY (session_id, version)
  )`,
  /**
   * The remainder is derived: a session's sources minus the ones already sealed into chunks.
   * Only the watermark is stored, because storing the set would be a second copy of membership
   * that can disagree with the first.
   */
  `CREATE TABLE IF NOT EXISTS session_remainders (
    session_id TEXT PRIMARY KEY,
    watermark TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  /**
   * Whole-session narratives written before chunks existed. `retired_at` is transaction time,
   * not the moment the content stopped being true: the row keeps serving until a chunk family
   * takes over, and what took over is recorded beside it.
   */
  `CREATE TABLE IF NOT EXISTS legacy_narratives (
    narrative_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    family TEXT NOT NULL DEFAULT 'legacy_session_overview',
    verification_status TEXT NOT NULL,
    verification_json TEXT,
    retired_at TEXT,
    retirement_family_json TEXT,
    created_at TEXT NOT NULL
  )`,
  /**
   * Ingest order for new intake, and never shared with the ordering a legacy scan uses.
   * `AUTOINCREMENT` for the reason the usage stream uses it: a position is never handed out
   * twice, so a keyset cursor holding one can only move forward and an aborted pass resumes
   * where it stopped.
   */
  `CREATE TABLE IF NOT EXISTS ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL UNIQUE,
    recorded_at TEXT NOT NULL
  )`,
];

/**
 * The retry columns and the coverage payload reach a substrate that already holds revision
 * rows by ALTER. The literals match the CREATE statements above and their order matches too,
 * which is what makes a fresh file and a retrofitted one the same table.
 */
export const NARRATIVE_COLUMN_ADDITIONS: readonly ColumnAddition[] = [
  { table: 'chunks', column: 'overlaps_json', definition: 'TEXT' },
  { table: 'chunks', column: 'overlaps_truncated', definition: 'INTEGER' },
  { table: 'chunk_revisions', column: 'coverage_gaps_json', definition: 'TEXT' },
  {
    table: 'chunk_revisions',
    column: 'attempts',
    definition: 'INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)',
  },
  { table: 'chunk_revisions', column: 'next_attempt_at', definition: 'TEXT' },
  { table: 'chunk_revisions', column: 'blocked_reason', definition: 'TEXT' },
  { table: 'chunk_revisions', column: 'last_failure_reason', definition: 'TEXT' },
  { table: 'chunk_revisions', column: 'attempt_policy_json', definition: 'TEXT' },
  { table: 'chunk_revisions', column: 'claim_expires_at', definition: 'TEXT' },
  {
    table: 'overview_revisions',
    column: 'attempts',
    definition: 'INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)',
  },
  { table: 'overview_revisions', column: 'next_attempt_at', definition: 'TEXT' },
  { table: 'overview_revisions', column: 'blocked_reason', definition: 'TEXT' },
  { table: 'overview_revisions', column: 'last_failure_reason', definition: 'TEXT' },
  { table: 'overview_revisions', column: 'attempt_policy_json', definition: 'TEXT' },
  { table: 'overview_revisions', column: 'claim_expires_at', definition: 'TEXT' },
];

export const NARRATIVE_INDEX_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS chunks_session_idx ON chunks (session_id, state)`,
  `CREATE INDEX IF NOT EXISTS chunk_members_chunk_idx ON chunk_members (chunk_id, member_ordinal)`,
  `CREATE INDEX IF NOT EXISTS revision_dependencies_rev_idx
     ON revision_dependencies (narrative_node_id)`,
  `CREATE INDEX IF NOT EXISTS revision_citations_target_idx
     ON revision_citations (target_id, target_kind)`,
  // Nomination reads an effective due time, so the index is over the same expression the
  // statement writes: an index on `next_attempt_at` alone cannot seek a row that has never
  // failed and therefore has none. Blocked rows and every state but `allocated` are out of
  // the index rather than filtered out of the result.
  `CREATE INDEX IF NOT EXISTS chunk_revisions_retry_idx
     ON chunk_revisions (COALESCE(next_attempt_at, allocated_at), chunk_id, revision_no)
     WHERE state = 'allocated' AND blocked_reason IS NULL`,
  `CREATE INDEX IF NOT EXISTS overview_revisions_retry_idx
     ON overview_revisions (COALESCE(next_attempt_at, allocated_at), family_key, revision_no)
     WHERE state = 'allocated' AND blocked_reason IS NULL`,
];
