import type { SqliteHandle } from './database.js';

/**
 * The durable record of batched generation: what is owed, what a remote job is holding, and what
 * became of each answer. Reads and writes are scoped to one substrate identity, so a reset
 * partitions old answers away rather than applying them to a store that never asked.
 */

export type BatchWorkState = 'pending' | 'submitted' | 'applied' | 'discarded' | 'failed';

export type BatchWorkItem = {
  /** The `custom_id` the request carries, and what a result is matched back by. */
  readonly workKey: string;
  /** The producer's own identity for the question, which the work key above is derived from. */
  readonly durableKey: string;
  readonly substrateId: string;
  readonly surface: string;
  /** What the substrate looked like where the request was built, read back at apply time. */
  readonly revalidation: unknown;
  readonly request: unknown;
  /** The shared frame version the request was assembled under, where the producer recorded one. */
  readonly frameVersion: string | undefined;
  readonly state: BatchWorkState;
  readonly batchId: string | undefined;
  /** The day's spending hold the submission took, so the answers can reconcile it. */
  readonly reservationId: string | undefined;
  readonly attempts: number;
  readonly lastError: string | undefined;
  readonly enqueuedAt: string;
  readonly submittedAt: string | undefined;
  readonly settledAt: string | undefined;
};

type Row = {
  work_key: string;
  durable_key: string;
  substrate_id: string;
  surface: string;
  revalidation_json: string;
  request_json: string;
  frame_version: string | null;
  state: string;
  batch_id: string | null;
  reservation_id: string | null;
  attempts: number;
  last_error: string | null;
  enqueued_at: string;
  submitted_at: string | null;
  settled_at: string | null;
};

function toItem(row: Row): BatchWorkItem {
  return {
    workKey: row.work_key,
    durableKey: row.durable_key,
    substrateId: row.substrate_id,
    surface: row.surface,
    revalidation: JSON.parse(row.revalidation_json) as unknown,
    request: JSON.parse(row.request_json) as unknown,
    frameVersion: row.frame_version ?? undefined,
    state: row.state as BatchWorkState,
    batchId: row.batch_id ?? undefined,
    reservationId: row.reservation_id ?? undefined,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    enqueuedAt: row.enqueued_at,
    submittedAt: row.submitted_at ?? undefined,
    settledAt: row.settled_at ?? undefined,
  };
}

export type EnqueueBatchWork = {
  readonly workKey: string;
  /**
   * The producer's own identity for this question, where the work key is a digest of it. Absent
   * where the producer's identity is already what the remote accepts, and the two are then the
   * same string.
   */
  readonly durableKey?: string;
  readonly substrateId: string;
  readonly surface: string;
  readonly revalidation: unknown;
  readonly request: unknown;
  /**
   * The frame version the request was assembled under, recorded beside it.
   *
   * An outstanding request is never rebuilt: the stored body is what is submitted, so the frame
   * it carries is the frame it was written with whatever the release has moved on to. This is
   * the version as a column so a reader can say which one that was without parsing the body.
   */
  readonly frameVersion?: string;
  readonly now: Date;
};

/**
 * Records work as owed. The work key is the identity, so a caller that enqueues the same item
 * twice finds the row it already wrote rather than submitting the same request again.
 *
 * A row that is already terminal stays terminal: re-enqueuing an applied judgment would spend
 * the money again on an answer the substrate already took.
 */
export function enqueueBatchWork(db: SqliteHandle, work: EnqueueBatchWork): boolean {
  const result = db
    .prepare(
      `INSERT INTO batch_work
         (work_key, durable_key, substrate_id, surface, revalidation_json, request_json,
          frame_version, state, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(work_key) DO NOTHING`,
    )
    .run(
      work.workKey,
      work.durableKey ?? work.workKey,
      work.substrateId,
      work.surface,
      JSON.stringify(work.revalidation),
      JSON.stringify(work.request),
      work.frameVersion ?? null,
      work.now.toISOString(),
    );
  return result.changes > 0;
}

export function readBatchWork(db: SqliteHandle, workKey: string): BatchWorkItem | undefined {
  const row = db.prepare('SELECT * FROM batch_work WHERE work_key = ?').get(workKey) as
    Row | undefined;
  return row === undefined ? undefined : toItem(row);
}

/** Work owed by this substrate, oldest first, bounded by what one submission may carry. */
export function pendingBatchWork(
  db: SqliteHandle,
  substrateId: string,
  limit: number,
): readonly BatchWorkItem[] {
  if (limit <= 0) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT * FROM batch_work
       WHERE substrate_id = ? AND state = 'pending'
       ORDER BY enqueued_at, work_key
       LIMIT ?`,
    )
    .all(substrateId, limit) as Row[];
  return rows.map(toItem);
}

/** The remote jobs this substrate is still waiting on, each named once. */
export function outstandingBatchIds(db: SqliteHandle, substrateId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT batch_id FROM batch_work
       WHERE substrate_id = ? AND state = 'submitted' AND batch_id IS NOT NULL
       ORDER BY batch_id`,
    )
    .all(substrateId) as { batch_id: string }[];
  return rows.map((row) => row.batch_id);
}

export function submittedBatchWork(db: SqliteHandle, batchId: string): readonly BatchWorkItem[] {
  const rows = db
    .prepare(`SELECT * FROM batch_work WHERE batch_id = ? AND state = 'submitted'`)
    .all(batchId) as Row[];
  return rows.map(toItem);
}

/**
 * The keys this batch has already settled, whatever became of them.
 *
 * Each of them reached a terminal state because an answer for it came back, so each of them is a
 * charge the remote made. That is what an accounting check reads: a row settled with no bill
 * against its request identity is money nobody has written down, not money nobody spent.
 */
export function settledBatchWorkKeys(db: SqliteHandle, batchId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT work_key FROM batch_work
       WHERE batch_id = ? AND state IN ('applied', 'discarded', 'failed')
       ORDER BY work_key`,
    )
    .all(batchId) as { work_key: string }[];
  return rows.map((row) => row.work_key);
}

/**
 * Names the remote request every one of these items is riding in, in one transaction.
 *
 * Submission is not completion: this only records who is holding the work. A process that dies
 * between the API accepting the batch and this write leaves the rows pending, and the next
 * submission re-sends them, which costs a duplicate batch rather than a lost judgment.
 *
 * The spending hold travels with the identity for the same reason the identity is written at all:
 * the answers arrive in another process, possibly a day later, and they are what reconciles the
 * maximum this submission held with what it actually cost.
 */
export function markBatchSubmitted(
  db: SqliteHandle,
  workKeys: readonly string[],
  batchId: string,
  now: Date,
  reservationId?: string,
): void {
  const statement = db.prepare(
    `UPDATE batch_work
     SET state = 'submitted', batch_id = ?, reservation_id = ?, submitted_at = ?,
         attempts = attempts + 1
     WHERE work_key = ? AND state = 'pending'`,
  );
  db.transaction(() => {
    for (const key of workKeys) {
      statement.run(batchId, reservationId ?? null, now.toISOString(), key);
    }
  }).immediate();
}

/**
 * Puts work back on the queue: an expired batch, a cancelled one, or a retryable error. The
 * remote identity is cleared, because the next attempt is a different request.
 *
 * The reservation is cleared with it. What that submission spent is already reconciled against
 * its own hold, and the next attempt is a new dispatch that takes a new one.
 */
export function returnBatchWork(
  db: SqliteHandle,
  workKey: string,
  reason: string,
  now: Date,
): void {
  db.prepare(
    `UPDATE batch_work
     SET state = 'pending', batch_id = NULL, reservation_id = NULL, submitted_at = NULL,
         last_error = ?, settled_at = ?
     WHERE work_key = ?`,
  ).run(reason, now.toISOString(), workKey);
}

/**
 * Puts a question the substrate discarded back on the queue.
 *
 * Discarding an answer settles the question with nothing written, and the key is derived from the
 * inputs, so a producer that reads exactly those inputs again finds a terminal row where its work
 * should be and leaves nothing actionable behind. The premise that moved has moved back: the
 * caller has just read it. Only a discarded row reopens, and only for the substrate that owns it.
 * An applied one is answered, and a failed one names a reason that reading the graph again does
 * not change. The reason it was discarded stays on the row: it is the history of the question,
 * not a verdict on it.
 */
export function reopenDiscardedBatchWork(
  db: SqliteHandle,
  workKey: string,
  substrateId: string,
  now: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE batch_work
       SET state = 'pending', batch_id = NULL, reservation_id = NULL, submitted_at = NULL,
           enqueued_at = ?, settled_at = NULL
       WHERE work_key = ? AND substrate_id = ? AND state = 'discarded'`,
    )
    .run(now.toISOString(), workKey, substrateId);
  return result.changes > 0;
}

/** A terminal outcome: applied, discarded as stale, or failed for good. */
export function settleBatchWork(
  db: SqliteHandle,
  workKey: string,
  state: 'applied' | 'discarded' | 'failed',
  reason: string | undefined,
  now: Date,
): void {
  db.prepare(
    `UPDATE batch_work SET state = ?, last_error = ?, settled_at = ? WHERE work_key = ?`,
  ).run(state, reason ?? null, now.toISOString(), workKey);
}

export type BatchWorkCounts = Readonly<Record<BatchWorkState, number>>;

const ZERO_COUNTS: BatchWorkCounts = {
  pending: 0,
  submitted: 0,
  applied: 0,
  discarded: 0,
  failed: 0,
};

/** What this substrate has outstanding and what it has settled, for `aion costs` and doctor. */
export function batchWorkCounts(db: SqliteHandle, substrateId: string): BatchWorkCounts {
  const rows = db
    .prepare(
      'SELECT state, COUNT(*) AS count FROM batch_work WHERE substrate_id = ? GROUP BY state',
    )
    .all(substrateId) as { state: string; count: number }[];
  const counts: Record<string, number> = { ...ZERO_COUNTS };
  for (const row of rows) {
    counts[row.state] = row.count;
  }
  return counts as BatchWorkCounts;
}
