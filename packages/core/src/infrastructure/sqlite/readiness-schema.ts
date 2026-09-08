import type { ColumnAddition } from './column-additions.js';

/**
 * Readiness records: the policy a source was processed under, the generation it was processed
 * in, the work that generation still owes, and the nodes that have been observed with nothing
 * supporting them. What readiness requires is a policy question answered elsewhere; these
 * tables hold the answers durably.
 */
export const READINESS_SCHEMA_STATEMENTS: readonly string[] = [
  /**
   * A policy revision is immutable once anything has been processed under it. Changing what
   * readiness requires writes a new revision, so a proof made under the old one still says
   * what it was measured against.
   */
  `CREATE TABLE IF NOT EXISTS readiness_policies (
    policy_revision INTEGER PRIMARY KEY,
    contract_digest TEXT NOT NULL,
    pipeline_version TEXT NOT NULL,
    stages_json TEXT NOT NULL,
    transfer_capabilities_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  /**
   * One row per source and processing generation. A generation is allocated durably before
   * anything outside uses it, and an abandoned or replaced number never comes back.
   *
   * `operational_revision` is the counter readiness binds to. A proof cites the source, the
   * generation and this number together, because the generation alone cannot say that a newly
   * owed work row landed after the proof was made. Every committed readiness transition
   * advances it in the same transaction as the change itself.
   */
  `CREATE TABLE IF NOT EXISTS source_processing_generations (
    source_id TEXT NOT NULL,
    processing_generation INTEGER NOT NULL CHECK (processing_generation > 0),
    policy_revision INTEGER NOT NULL,
    input_digest TEXT,
    state TEXT NOT NULL CHECK (state IN ('allocated','active','replaced')),
    inventory_complete INTEGER NOT NULL DEFAULT 0 CHECK (inventory_complete IN (0,1)),
    inventory_revision INTEGER,
    adoption_proof_json TEXT,
    created_at TEXT NOT NULL,
    operational_revision INTEGER NOT NULL DEFAULT 0 CHECK (operational_revision >= 0),
    PRIMARY KEY (source_id, processing_generation)
  )`,
  /**
   * The obligations a generation owes. Existing queue leases and operation runners execute
   * them; nothing here is a second execution engine.
   *
   * Every stage the policy requires has a row, and a completed stage carries a typed outcome
   * saying it completed or why it does not apply, with the proof behind that. Row presence is
   * therefore not the completeness test: the helper reads the outcome. A runnable state has to
   * carry a due time, which is what the second CHECK says.
   */
  `CREATE TABLE IF NOT EXISTS source_work (
    work_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    processing_generation INTEGER NOT NULL,
    kind TEXT NOT NULL,
    stage_name TEXT,
    work_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','retryable','transferred','completed','obsolete','pinned','dead_letter')),
    reason TEXT,
    input_revision_json TEXT,
    outcome_json TEXT,
    continuation_json TEXT,
    capability_revision INTEGER,
    publication_operation_id TEXT,
    due_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    completed_at TEXT,
    UNIQUE (source_id, processing_generation, kind, work_key),
    CHECK (state NOT IN ('pending','retryable','transferred') OR due_at IS NOT NULL),
    CHECK (kind != 'stage' OR stage_name IS NOT NULL),
    CHECK (kind != 'stage' OR state != 'completed'
        OR (outcome_json IS NOT NULL AND completed_at IS NOT NULL))
  )`,
  /**
   * Nodes observed with nothing supporting them. `first_verified_at` starts when the full
   * unsupported predicate certifies, not when a partial read first missed the support, and any
   * change to the bound scope resets the row. Aging an orphan from a clock that started on an
   * incomplete read is how a live node gets forgotten.
   */
  `CREATE TABLE IF NOT EXISTS orphan_observations (
    node_id TEXT PRIMARY KEY,
    first_verified_at TEXT NOT NULL,
    evidence_revision_json TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    disposition TEXT NOT NULL,
    reason TEXT,
    updated_at TEXT NOT NULL
  )`,
];

export const READINESS_COLUMN_ADDITIONS: readonly ColumnAddition[] = [
  {
    table: 'source_processing_generations',
    column: 'operational_revision',
    definition: 'INTEGER NOT NULL DEFAULT 0 CHECK (operational_revision >= 0)',
  },
];

export const READINESS_INDEX_STATEMENTS: readonly string[] = [
  // At most one active generation per source, enforced by the store rather than by whoever
  // writes the row. Replaced and allocated generations are outside the index, so a source
  // keeps its whole history and still has one current generation.
  `CREATE UNIQUE INDEX IF NOT EXISTS source_processing_generations_active_idx
     ON source_processing_generations (source_id) WHERE state = 'active'`,
  // Outstanding work only, ordered by the keyset a runner pages on. Completed and abandoned
  // rows are out of the index rather than filtered out of the result, so the backlog scan
  // costs what the backlog is rather than what the table holds.
  `CREATE INDEX IF NOT EXISTS source_work_outstanding_idx
     ON source_work (due_at, source_id, work_id)
     WHERE state IN ('pending','retryable','transferred')`,
  `CREATE INDEX IF NOT EXISTS source_work_source_idx
     ON source_work (source_id, processing_generation)`,
];
