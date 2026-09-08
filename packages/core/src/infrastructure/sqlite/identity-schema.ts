/**
 * Source identity and the evidence records that hang off it: what a source occurrence is,
 * which parts it holds, which semantic links touch it, and how much history a reader may
 * claim. Every statement is additive and the experience archive is untouched, so these tables
 * sit beside it and key on the ids it already carries.
 */
export const IDENTITY_SCHEMA_STATEMENTS: readonly string[] = [
  /**
   * One row per source occurrence, keyed on the episode id the archive already carries. A
   * source that was forgotten and pushed again mints a second occurrence rather than
   * rewriting the first, so the forgotten statement survives its replacement.
   *
   * The archive-mapping columns are nullable because a source can exist in the graph with no
   * archive row behind it, and minting an archive id for one would record a proof nobody
   * made. Such a row is pinned instead. The table-level CHECK is what makes `verified` mean
   * something: it holds only when the whole archive proof is present, so a row cannot claim
   * verification with half of it.
   *
   * Nothing here changes because storage moved. Residency is operational state with a table
   * of its own; these rows are evidence.
   */
  `CREATE TABLE IF NOT EXISTS source_records (
    source_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    canonical_archive_id TEXT,
    archive_aliases_json TEXT,
    archive_schema_version INTEGER,
    identity_hash TEXT,
    verified_content_digest TEXT,
    verification_policy_version INTEGER,
    verification_status TEXT NOT NULL CHECK (verification_status IN ('verified','unresolved','pinned')),
    verification_reason TEXT,
    occurred_at TEXT NOT NULL,
    archived_at TEXT,
    graph_clocks_json TEXT,
    capture_order_value TEXT,
    capture_order_basis TEXT,
    origin TEXT,
    created_at TEXT NOT NULL,
    CHECK (verification_status != 'verified'
        OR (canonical_archive_id IS NOT NULL AND archive_schema_version IS NOT NULL
            AND identity_hash IS NOT NULL AND verified_content_digest IS NOT NULL
            AND verification_policy_version IS NOT NULL AND archived_at IS NOT NULL))
  )`,
  /**
   * One row per part of a source: a turn, an observation, or a tool execution. Only turns
   * have an original turn id, so the column is nullable and the uniqueness rule that covers
   * it is a partial index rather than a constraint. `role` is the role that was recorded, or
   * null. It is never inferred from position or content.
   */
  `CREATE TABLE IF NOT EXISTS source_parts (
    source_id TEXT NOT NULL,
    part_kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    turn_id TEXT,
    role TEXT,
    content_hash TEXT NOT NULL,
    occurred_at TEXT,
    graph_clocks_json TEXT,
    PRIMARY KEY (source_id, part_kind, ordinal)
  )`,
  /**
   * Reference history, one row per accepted batch, so the merged union stops being the only
   * record of what arrived and when. `accepted_hash` is the canonical hash of the accepted
   * set: a batch that repeats the set already held adds no version. `UNIQUE (source_id,
   * operation_key)` is what makes a retried delivery one row rather than two.
   */
  `CREATE TABLE IF NOT EXISTS source_reference_batches (
    source_id TEXT NOT NULL,
    reference_version INTEGER NOT NULL CHECK (reference_version > 0),
    accepted_hash TEXT NOT NULL,
    received_at TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    introduced_json TEXT NOT NULL,
    PRIMARY KEY (source_id, reference_version),
    UNIQUE (source_id, operation_key)
  )`,
  /**
   * Durable semantic links. `qualifier` disambiguates categories that share a pair of
   * endpoints; it is drawn from a closed enumeration, and a write carrying an unclassified
   * one is rejected by the helper rather than stored as free text. `original_rel_id` keeps
   * the relationship identity the graph minted, so a rebuild produces the same link rather
   * than a new one that looks like it.
   */
  `CREATE TABLE IF NOT EXISTS evidence_links (
    link_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    qualifier TEXT NOT NULL DEFAULT '',
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    original_rel_id TEXT,
    record_source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (kind, qualifier, from_id, to_id)
  )`,
  /**
   * The immutable version chain behind a link. A question about what was true at some past
   * moment reads this chain; the current projection is never the answer to it.
   *
   * `operation_id` is the publication that owns the version. A row joins the committed view
   * only once that operation is acknowledged, so a prepared write is durable and invisible at
   * the same time. `known_from` is assigned at acknowledgment and stays null before it.
   */
  `CREATE TABLE IF NOT EXISTS evidence_link_versions (
    link_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    prev_version INTEGER,
    state TEXT NOT NULL,
    recorded_values_json TEXT NOT NULL,
    temporal_proof_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    operation_id TEXT,
    known_from TEXT,
    observed_ack_at TEXT,
    reference_source_id TEXT,
    reference_version INTEGER,
    PRIMARY KEY (link_id, version),
    UNIQUE (link_id, operation_key)
  )`,
  /**
   * Writer-owned scope counters. A dependency cites the published token, which is a hash over
   * the endpoint, the relation class and the published revision: opaque, and comparable only
   * for equality.
   *
   * Three numbers rather than one. `published_revision` is what readers cite.
   * `allocated_revision` is the high-water mark, so a number a rejected attempt consumed is
   * never handed out again. `pending_revision` with its owning operation is the prepared
   * advance: acknowledgment promotes it to published, and a rejection clears the pair and
   * leaves the published number exactly where it was.
   *
   * `census_status` is what stops an unbackfilled absence from reading as a verified empty
   * set. It reaches 'established' through an acknowledged baseline operation, never because a
   * reader looked and found nothing.
   */
  `CREATE TABLE IF NOT EXISTS evidence_scope_versions (
    endpoint_id TEXT NOT NULL,
    relation_class TEXT NOT NULL,
    published_revision INTEGER NOT NULL CHECK (published_revision >= 0),
    allocated_revision INTEGER NOT NULL CHECK (allocated_revision >= published_revision),
    pending_revision INTEGER,
    pending_operation_id TEXT,
    census_status TEXT NOT NULL CHECK (census_status IN ('established','unbackfilled','unknown')),
    coverage_json TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (endpoint_id, relation_class),
    CHECK ((pending_revision IS NULL) = (pending_operation_id IS NULL))
  )`,
  /**
   * A mirror of the scope counters the graph owns, kept for history reads and diagnostics. The
   * graph advances its own counter in its own transaction, so a mismatch here proves the
   * mirror is stale and a match proves nothing at all. Certification of a read comes from the
   * publication checkpoint, never from this table.
   */
  `CREATE TABLE IF NOT EXISTS evidence_scope_mirrors (
    endpoint_id TEXT NOT NULL,
    relation_class TEXT NOT NULL,
    mirrored_revision INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    mirrored_at TEXT NOT NULL,
    PRIMARY KEY (endpoint_id, relation_class)
  )`,
  /**
   * Forget and suppression transitions on a source. They are statements about the source
   * alone, with no second endpoint to hang a link version on, so they get an append-only
   * record of their own and the suppression evidence outlives the content it suppressed.
   */
  `CREATE TABLE IF NOT EXISTS source_state_versions (
    source_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    state_kind TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    known_from TEXT,
    observed_at TEXT NOT NULL,
    detail_json TEXT,
    PRIMARY KEY (source_id, version)
  )`,
  /**
   * Per-effect acknowledgment for one accepted reference batch. Rebuilding the raw record and
   * processing it semantically are different obligations, so they carry different
   * `effect_kind` values and never share a row: one completing says nothing about the other.
   */
  `CREATE TABLE IF NOT EXISTS evidence_acknowledgments (
    source_id TEXT NOT NULL,
    reference_version INTEGER NOT NULL,
    effect_kind TEXT NOT NULL,
    state TEXT NOT NULL,
    completed_at TEXT,
    detail_json TEXT,
    PRIMARY KEY (source_id, reference_version, effect_kind)
  )`,
  /**
   * The full incidence relation between sources and nodes, never a count. Counts are derived
   * from it and ownership reads materialize from it.
   *
   * A row is the current projection of its link, which is why the link binding is required:
   * a question about ownership at some past moment resolves through the link's immutable
   * version chain, not through this mutable row. The committed view is the rows whose link
   * version belongs to an acknowledged operation.
   */
  `CREATE TABLE IF NOT EXISTS source_incidence (
    source_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    role TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (currency IN ('open','closed')),
    clocks_json TEXT,
    link_id TEXT NOT NULL,
    link_version INTEGER NOT NULL,
    PRIMARY KEY (source_id, node_id, role)
  )`,
  /**
   * The coverage control record: how far back a reader may claim history reaches.
   *
   * `registry_revision` keys the rows and the current record is the highest one.
   * `contract_version` is the wire contract the record is spoken in and stays 1 across a
   * preparation and its activation, so it is not a key and never moves when a row is added.
   * `epoch` is an equality fence: a reader holding an older epoch is out of date whatever its
   * numbers say.
   *
   * A preparing row carries neither `history_since` nor `activated_at`, because a placeholder
   * for either would invent a boundary nobody set. Activation writes a new revision with both
   * set and a fresh epoch, in one transaction.
   */
  `CREATE TABLE IF NOT EXISTS coverage_contract (
    registry_revision INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_version INTEGER NOT NULL DEFAULT 1,
    epoch TEXT NOT NULL,
    history_since TEXT,
    activated_at TEXT,
    field_policy_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('preparing','active')),
    CHECK ((state = 'preparing' AND history_since IS NULL AND activated_at IS NULL)
        OR (state = 'active' AND history_since IS NOT NULL AND activated_at IS NOT NULL))
  )`,
];

export const IDENTITY_INDEX_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS source_records_session_idx
     ON source_records (session_id, capture_order_value)`,
  `CREATE INDEX IF NOT EXISTS source_records_archive_idx ON source_records (canonical_archive_id)`,
  // The occurrence lookup an accepted payload runs before anything else. Two occurrences of one
  // payload share this key and hold different canonical archive rows, so the canonical index
  // above cannot serve it.
  `CREATE INDEX IF NOT EXISTS source_records_identity_idx
     ON source_records (identity_hash, session_id) WHERE identity_hash IS NOT NULL`,
  // Unique where an original turn id exists, and silent about parts that have none. A
  // constraint would force every observation part to invent one.
  `CREATE UNIQUE INDEX IF NOT EXISTS source_parts_turn_idx
     ON source_parts (turn_id) WHERE turn_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS evidence_links_from_idx ON evidence_links (from_id, kind)`,
  `CREATE INDEX IF NOT EXISTS evidence_links_to_idx ON evidence_links (to_id, kind)`,
  // Serves both the ownership materialization and the count derivation, which ask the same
  // question from the node's side.
  `CREATE INDEX IF NOT EXISTS source_incidence_node_idx
     ON source_incidence (node_id, role, currency)`,
];
