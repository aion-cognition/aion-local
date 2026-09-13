/**
 * The outstanding half of batched generation.
 *
 * A batch request outlives the process that submitted it: the API takes up to 24 hours, and the
 * service restarts, crashes and gets upgraded inside that window. Everything needed to pick a
 * result back up is a row here, keyed by the `custom_id` the request carried, so consumption is
 * by identity rather than by order.
 *
 * `substrate_id` is what keeps an old answer out of a new substrate. A reset mints a new
 * identity, so a batch submitted before it can still land, still be read, and still be
 * recognized as belonging to a substrate that no longer exists. Content-derived work keys repeat
 * across a reset; the identity does not.
 *
 * `revalidation` is what the substrate looked like where the request was built. Nothing is
 * applied without checking it against the substrate at apply time: hours passed, and the pair
 * the judgment is about may have merged, been superseded, or been forgotten.
 */
export const BATCH_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS batch_work (
    work_key TEXT PRIMARY KEY,
    substrate_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    -- What the request was built against, as the surface's own handler reads it back.
    revalidation_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    -- pending: owed, not submitted. submitted: the remote holds it. applied/discarded/failed
    -- are terminal, and each says which of them happened and why.
    state TEXT NOT NULL CHECK (state IN ('pending', 'submitted', 'applied', 'discarded', 'failed')),
    -- The remote request identity. Null until a submission names one.
    batch_id TEXT,
    -- The spending reservation the submission took against the day's ceiling, so the hold can be
    -- reconciled with what the answers actually cost whenever they come back, including after a
    -- restart. Null on a row nothing has submitted yet.
    reservation_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    enqueued_at TEXT NOT NULL,
    submitted_at TEXT,
    settled_at TEXT
  )`,
];

export const BATCH_INDEX_STATEMENTS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS batch_work_state_idx ON batch_work(substrate_id, state)',
  'CREATE INDEX IF NOT EXISTS batch_work_batch_idx ON batch_work(batch_id)',
];
