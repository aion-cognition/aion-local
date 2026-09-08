/**
 * Publication, residency and the frozen migration cohort. These records are operational: they
 * say which write is in flight, what a completed one returned, where a source's storage sits,
 * and how far a bounded backfill has walked. None of them is evidence about what happened in
 * a conversation.
 */
export const PUBLICATION_SCHEMA_STATEMENTS: readonly string[] = [
  /**
   * The paired substrate's own identity, one row, minted at first initialization.
   *
   * `bootstrap_state` is the durable marker the guard-node creation is conditional on. While
   * it reads 'pairing' the initial bootstrap is provably unfinished and the guard may be
   * created; once it reads 'initialized' a missing guard is an inconsistency to report, and
   * the replayed migration runner must not quietly mint a second one over the top of it.
   *
   * Two processes opening a fresh substrate at the same instant serialize on this row: the
   * singleton comes from reading and inserting inside one immediate transaction, not from the
   * id being random.
   */
  `CREATE TABLE IF NOT EXISTS publication_control (
    substrate_id TEXT PRIMARY KEY,
    bootstrap_state TEXT NOT NULL CHECK (bootstrap_state IN ('pairing','initialized')),
    protocol_version INTEGER NOT NULL,
    last_ack_sequence INTEGER NOT NULL DEFAULT 0,
    pending_operation_id TEXT,
    last_known_from TEXT,
    activation_capability_revision INTEGER NOT NULL DEFAULT 0
  )`,
  /**
   * One immutable row per publication, holding both the prepared input and the outcome.
   *
   * The graph guard keeps only the newest receipt, so a retry of an operation that a later one
   * has already overwritten there would have nothing to answer from. This table keeps every
   * acknowledged operation's receipt and clocks for good, and the retry reads its own result
   * back rather than inferring one from the graph.
   *
   * `payload_json` is the input, durable before the graph is touched, and it is never
   * overwritten with the outcome: `result_json` holds that, or an exact typed reference to it.
   * The CHECK is why a digest alone cannot pass for an acknowledgment.
   *
   * Both clocks live here for every kind of operation, so an acknowledgment that created no
   * link version and no chunk revision still has a visibility clock and a wall time recorded.
   * `sequence` is allocated by `AUTOINCREMENT` inside the prepare transaction and never
   * reused.
   */
  `CREATE TABLE IF NOT EXISTS publication_intents (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    affected_scopes_json TEXT NOT NULL,
    expected_json TEXT NOT NULL,
    prepared_actions_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared','acknowledged','deferred','rejected')),
    error TEXT,
    result_digest TEXT,
    result_json TEXT,
    known_from TEXT,
    observed_ack_at TEXT,
    clock_clamped INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    CHECK (state != 'acknowledged'
        OR (result_digest IS NOT NULL AND result_json IS NOT NULL
            AND known_from IS NOT NULL AND observed_ack_at IS NOT NULL))
  )`,
  /**
   * The idempotent effects one operation owes, and whether each has completed. A recovery
   * finishes the pending ones rather than replaying the operation.
   */
  `CREATE TABLE IF NOT EXISTS publication_effects (
    operation_id TEXT NOT NULL,
    effect_kind TEXT NOT NULL,
    state TEXT NOT NULL,
    completed_at TEXT,
    detail_json TEXT,
    PRIMARY KEY (operation_id, effect_kind)
  )`,
  `CREATE INDEX IF NOT EXISTS publication_intents_pending_idx
    ON publication_intents(operation_id) WHERE state = 'prepared'`,
  /**
   * Where a source's storage sits. `projection_generation` advances on every transition
   * attempt, not on every success, so a generation number is never reused by a retry of the
   * transition that failed under it.
   */
  `CREATE TABLE IF NOT EXISTS source_residency (
    source_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('resident','retiring','evicted')),
    projection_generation INTEGER NOT NULL,
    active_operation_id TEXT,
    manifest_digest TEXT,
    transitioned_at TEXT NOT NULL,
    rebuild_ack_at TEXT
  )`,
  /**
   * What an eviction is about to remove, written before it removes anything and never edited
   * after. `survivor_obligations_json` holds the recompute work the removal creates, which
   * becomes runnable only once the delete receipt is in hand.
   */
  `CREATE TABLE IF NOT EXISTS eviction_manifests (
    operation_id TEXT PRIMARY KEY,
    removal_set_json TEXT NOT NULL,
    content_digests_json TEXT NOT NULL,
    evidence_versions_json TEXT NOT NULL,
    incident_edges_json TEXT NOT NULL,
    survivor_obligations_json TEXT NOT NULL,
    readiness_policy_revision INTEGER NOT NULL,
    expected_outcome_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  /**
   * The frozen legacy cohort. Its bounds are captured at the freeze and are separate from the
   * live intake watermark, so the cohort is reproducible and the gap between the two streams
   * is closed rather than assumed away. `scan_cursor` is the resumable position inside the
   * bounds: a restart mid-cohort continues from it instead of rescanning or skipping.
   */
  `CREATE TABLE IF NOT EXISTS migration_cohorts (
    cohort_id TEXT PRIMARY KEY,
    cohort_digest TEXT NOT NULL,
    intake_watermark INTEGER NOT NULL,
    archive_rowid_low INTEGER NOT NULL,
    archive_rowid_high INTEGER NOT NULL,
    graph_census_digest TEXT NOT NULL,
    scan_cursor INTEGER,
    ordering_policy_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  /**
   * One row per distinct source in the cohort, written as 'accounted' at the freeze and
   * before any verification pages. The enumeration is the durable membership and the digest
   * only cross-checks it: a digest cannot re-list the graph-only sources after a restart.
   *
   * Multiple archive rows of one source are accounted through the frozen bounds and the
   * alias list on the source record, so an alias never gets a progress row of its own.
   * `partition_assignment` is immutable once written: a better clock proof arriving later
   * improves the evidence and does not move a source between chunks.
   */
  `CREATE TABLE IF NOT EXISTS migration_progress (
    cohort_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    partition_assignment TEXT,
    PRIMARY KEY (cohort_id, source_id)
  )`,
];
