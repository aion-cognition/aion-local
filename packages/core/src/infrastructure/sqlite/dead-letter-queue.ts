import type { SqliteHandle } from './database.js';
import { getLedgerEntry, markLedgerApplied } from './ops-ledger.js';
import { readActiveGeneration } from './processing-generations.js';
import { readCurrentReadinessPolicy } from './readiness-policies.js';
import { REFLECTION_QUEUE_EPISODE_FIELD } from './reflection-queue.js';
import { listReferenceBatches } from './source-identity.js';

/**
 * The dead-letter half of `reflection_queue` admin: rows the claim path will never take
 * again (`attempts >= maxAttempts`, still unclaimed). `reflection-queue-admin.ts` covers
 * the operator's read/drop/promote surface; this file is narrower, built for the
 * introspector's `dead_letter` operation, which gives an exhausted row another cycle whenever
 * the conditions that decide its outcome differ from every cycle it already failed under.
 *
 * The queue table carries no column for the retries a row has had, so that history lives in
 * `ops_ledger` under `DEAD_LETTER_SEEN_LEDGER_PREFIX`, keyed by job id rather than by time
 * bucket. Each retry records the conditions it was granted under. A row that exhausts again
 * under conditions it already failed under stays queued and counted rather than looping.
 */

export const DEAD_LETTER_SEEN_LEDGER_PREFIX = 'intro:dead_letter:seen:';

export function deadLetterSeenKey(jobId: string): string {
  return `${DEAD_LETTER_SEEN_LEDGER_PREFIX}${jobId}`;
}

export type ExhaustedJob = {
  readonly id: string;
  readonly jobType: string;
  readonly enqueuedAt: string;
  /** The source the row is about, from its column or the payload an older row carried. */
  readonly sourceId: string | undefined;
};

/**
 * What decides whether one more cycle could end differently: the code the process runs, the
 * readiness policy the pipeline published (its stages and their options), the generation route,
 * and the source's own evidence (its active processing generation and newest accepted reference
 * batch). A queued job moves none of these by running, so a row whose conditions match a retry
 * it already failed would fail the same way again, and a row whose conditions moved has
 * something new to try.
 */
export type RetryConditions = {
  readonly build: string;
  readonly readinessPolicy: number;
  readonly generationRoute: string;
  readonly processingGeneration: number;
  readonly referenceVersion: number;
};

/** The half of the conditions every row in one pass shares. */
export type RetryEnvironment = Pick<
  RetryConditions,
  'build' | 'readinessPolicy' | 'generationRoute'
>;

/** One retry `dead_letter` granted. A retry recorded before conditions were kept carries none. */
export type DeadLetterRetry = {
  readonly at: string;
  readonly conditions?: RetryConditions;
};

export type RetriedExhaustedJob = ExhaustedJob & {
  readonly retries: readonly DeadLetterRetry[];
};

type ExhaustedRow = {
  id: string;
  job_type: string;
  enqueued_at: string;
  source_id: unknown;
};

const SOURCE_COLUMN = `COALESCE(NULLIF(q.episode_id, ''),
  json_extract(q.payload_json, '$.${REFLECTION_QUEUE_EPISODE_FIELD}')) AS source_id`;

function toExhaustedJob(row: ExhaustedRow): ExhaustedJob {
  const sourceId =
    typeof row.source_id === 'string' && row.source_id !== '' ? row.source_id : undefined;
  return { id: row.id, jobType: row.job_type, enqueuedAt: row.enqueued_at, sourceId };
}

/**
 * Oldest first: a row that has waited longest for attention waits longest for the retry too.
 *
 * Rows already carrying the seen marker are excluded in SQL rather than skipped by the caller.
 * A row that spent a retry keeps its original `enqueued_at`, so it sorts ahead of every newly
 * exhausted row forever; filtering after the fact would let a batch's worth of rows waiting on
 * changed conditions fill the batch and starve the rows that have never had a retry.
 */
export function listExhaustedJobs(
  db: SqliteHandle,
  maxAttempts: number,
  limit: number,
): ExhaustedJob[] {
  const rows = db
    .prepare(
      `SELECT q.id, q.job_type, q.enqueued_at, ${SOURCE_COLUMN} FROM reflection_queue q
       WHERE q.claimed_at IS NULL AND q.attempts >= ?
         AND NOT EXISTS (SELECT 1 FROM ops_ledger WHERE key = ? || q.id)
       ORDER BY q.enqueued_at ASC, q.rowid ASC
       LIMIT ?`,
    )
    .all(maxAttempts, DEAD_LETTER_SEEN_LEDGER_PREFIX, limit) as ExhaustedRow[];
  return rows.map(toExhaustedJob);
}

/**
 * Every exhausted row that has already had a retry, with the retries it had, oldest first.
 *
 * Unbounded on purpose. Which of these rows has something new to try is known only after its
 * conditions are read, so a page that always started at the front would read the same unchanged
 * rows on every pass and never reach the one whose evidence moved. Each row costs a few point
 * reads, and the population is rows that have failed at least twice.
 */
export function listRetriedExhaustedJobs(
  db: SqliteHandle,
  maxAttempts: number,
): RetriedExhaustedJob[] {
  const rows = db
    .prepare(
      `SELECT q.id, q.job_type, q.enqueued_at, ${SOURCE_COLUMN},
              l.applied_at, l.summary_json
         FROM reflection_queue q JOIN ops_ledger l ON l.key = ? || q.id
        WHERE q.claimed_at IS NULL AND q.attempts >= ?
        ORDER BY q.enqueued_at ASC, q.rowid ASC`,
    )
    .all(DEAD_LETTER_SEEN_LEDGER_PREFIX, maxAttempts) as (ExhaustedRow & {
    applied_at: string;
    summary_json: string | null;
  })[];
  return rows.map((row) => ({
    ...toExhaustedJob(row),
    retries: retriesFrom(
      row.summary_json === null ? undefined : (JSON.parse(row.summary_json) as unknown),
      row.applied_at,
    ),
  }));
}

function isRetryConditions(value: unknown): value is RetryConditions {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const held = value as Record<string, unknown>;
  return (
    typeof held.build === 'string' &&
    typeof held.generationRoute === 'string' &&
    typeof held.readinessPolicy === 'number' &&
    typeof held.processingGeneration === 'number' &&
    typeof held.referenceVersion === 'number'
  );
}

/**
 * The retries a marker records. A marker written before retries carried their conditions says
 * only that one retry happened, at the moment it was written, so it reads as exactly that.
 */
function retriesFrom(summary: unknown, markedAt: string): DeadLetterRetry[] {
  const listed =
    summary !== null && typeof summary === 'object'
      ? (summary as { retries?: unknown }).retries
      : undefined;
  if (!Array.isArray(listed) || listed.length === 0) {
    return [{ at: markedAt }];
  }
  return listed.map((entry: unknown) => {
    const held = (entry ?? {}) as { at?: unknown; conditions?: unknown };
    const at = typeof held.at === 'string' ? held.at : markedAt;
    return isRetryConditions(held.conditions) ? { at, conditions: held.conditions } : { at };
  });
}

/** The conditions every row shares in one pass, read once. */
export function readRetryEnvironment(
  db: SqliteHandle,
  running: Pick<RetryConditions, 'build' | 'generationRoute'>,
): RetryEnvironment {
  return {
    ...running,
    readinessPolicy: readCurrentReadinessPolicy(db)?.policyRevision ?? 0,
  };
}

/** One row's full conditions: the shared half plus what its own source holds now. */
export function readRetryConditions(
  db: SqliteHandle,
  environment: RetryEnvironment,
  sourceId: string | undefined,
): RetryConditions {
  if (sourceId === undefined) {
    return { ...environment, processingGeneration: 0, referenceVersion: 0 };
  }
  const references = listReferenceBatches(db, sourceId);
  return {
    ...environment,
    processingGeneration: readActiveGeneration(db, sourceId)?.processingGeneration ?? 0,
    referenceVersion: references[references.length - 1]?.referenceVersion ?? 0,
  };
}

function sameConditions(a: RetryConditions, b: RetryConditions): boolean {
  return (
    a.build === b.build &&
    a.readinessPolicy === b.readinessPolicy &&
    a.generationRoute === b.generationRoute &&
    a.processingGeneration === b.processingGeneration &&
    a.referenceVersion === b.referenceVersion
  );
}

/**
 * Whether a cycle under `current` could end differently from every cycle the row already had.
 * One cycle per distinct set of conditions, so a failure that repeats under unchanged conditions
 * never loops, and one whose conditions later return to an earlier set is not retried twice.
 *
 * A retry recorded without its conditions is one nobody kept the conditions of. It matches
 * nothing, so the row gets one cycle whose conditions are recorded, which bounds every later one.
 */
export function hasUntriedConditions(
  retries: readonly DeadLetterRetry[],
  current: RetryConditions,
): boolean {
  return !retries.some(
    (retry) => retry.conditions !== undefined && sameConditions(retry.conditions, current),
  );
}

/**
 * Appends one granted retry to the row's marker. The whole history stays, so the marker says how
 * many cycles the row has had and what each one ran under.
 */
export function recordDeadLetterRetry(
  db: SqliteHandle,
  job: ExhaustedJob,
  conditions: RetryConditions,
  at: Date,
): void {
  const key = deadLetterSeenKey(job.id);
  const held = getLedgerEntry(db, key);
  const prior = held === undefined ? [] : retriesFrom(held.summary, held.appliedAt);
  markLedgerApplied(db, key, {
    jobType: job.jobType,
    retries: [...prior, { at: at.toISOString(), conditions }],
  });
}

/**
 * Moves the job to the bulk lane and resets its attempt count, so the claim path can take
 * it again. Scoped to still-unclaimed rows: a row a worker picked up between the list and
 * this call is no longer this operation's to touch. Returns whether the row actually moved.
 *
 * `lane_seq` is restamped from the bulk group the row lands in, because the column numbers a
 * row within its own (lane, session) group. A retry that kept its old turn would sort ahead of
 * bulk work that has been waiting longer than it has.
 */
export function relaneDeadLetterJob(db: SqliteHandle, jobId: string): boolean {
  const result = db
    .prepare(
      `UPDATE reflection_queue
         SET lane = 'bulk',
             attempts = 0,
             lane_seq = (
               SELECT COALESCE(MAX(q.lane_seq), 0) + 1 FROM reflection_queue q
               WHERE q.lane = 'bulk' AND q.session_id IS reflection_queue.session_id
             )
       WHERE id = ? AND claimed_at IS NULL`,
    )
    .run(jobId);
  return result.changes > 0;
}

/**
 * Exhausted rows that already had a retry and exhausted again. `dead_letter` gives each one
 * another cycle once its conditions change, so the count is rows waiting on a changed build,
 * policy, route or evidence, plus any it has not reached yet. `application/observe.ts` reads
 * this into `QueueHealth`, which is how a failure that keeps repeating stays visible.
 */
export function countDeadLetterAttention(db: SqliteHandle, maxAttempts: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reflection_queue q
       WHERE q.claimed_at IS NULL AND q.attempts >= ?
         AND EXISTS (SELECT 1 FROM ops_ledger WHERE key = ? || q.id)`,
    )
    .get(maxAttempts, DEAD_LETTER_SEEN_LEDGER_PREFIX) as { n: number };
  return row.n;
}
