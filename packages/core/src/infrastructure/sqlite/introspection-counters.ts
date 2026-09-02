import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

/**
 * What the introspector remembers between ticks: the cycle counter starvation protection
 * measures against, and one small record per operation of what running it did. All of it in
 * `meta`, beside the plasticity counters, because it is the same kind of thing: a cumulative
 * reading an operator can ask for and a restart must not reset.
 *
 * The bucket claim is here rather than beside `markLedgerApplied` because it needs the
 * opposite conflict rule. Marking is an upsert, which is right for an operation recording what
 * it did; claiming is an insert that must lose to whoever inserted first, which is what stops
 * two service instances from running the same maintenance in the same window.
 */

const CYCLE_KEY = 'introspection:cycle';
const OPERATION_PREFIX = 'introspection:op:';

/**
 * Whether an operation moved the metric it declared, once the next snapshot could see it.
 * `unmeasured` is the resolution for a run there was no metric to score: the operation declares
 * none, or the one it declares could not be read. It counts as a run and answers nothing about
 * whether the run helped, which is the whole difference between it and the other three.
 */
export type OperationResolution = 'improved' | 'unchanged' | 'failed' | 'unmeasured';

export type OperationStats = {
  readonly name: string;
  /** Runs that have resolved. A run awaiting its next-cycle measurement is not counted yet. */
  readonly runs: number;
  readonly improved: number;
  readonly unchanged: number;
  readonly failed: number;
  /** Resolved runs no metric scored, so `runs` still sums to the four tallies. */
  readonly unmeasured: number;
  readonly lastRunAt?: string;
  /** Wall time the most recent run took, which is what "prefer the cheapest" is answered from. */
  readonly lastDurationMs?: number;
  /** Runs that have been timed, and their summed duration, so a mean survives a restart. */
  readonly durationRuns: number;
  readonly durationTotalMs: number;
  /** The cycle this operation was last selected on; absent until it has been. */
  readonly selectedCycle?: number;
  /** The metric reading taken before the last run, waiting on the next snapshot to score it. */
  readonly pendingMeasure?: number;
};

const EMPTY_STATS = { runs: 0, improved: 0, unchanged: 0, failed: 0, unmeasured: 0 } as const;

function key(name: string, leaf: string): string {
  return `${OPERATION_PREFIX}${name}:${leaf}`;
}

function readNumber(db: SqliteHandle, metaKey: string): number | undefined {
  const raw = getMeta(db, metaKey);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Advances and returns the cycle counter. Every tick calls it exactly once, so the difference
 * between it and an operation's `selectedCycle` is how many cycles that operation has been
 * passed over.
 */
export function nextIntrospectionCycle(db: SqliteHandle): number {
  const next = (readNumber(db, CYCLE_KEY) ?? 0) + 1;
  setMeta(db, CYCLE_KEY, String(next));
  return next;
}

export function introspectionCycle(db: SqliteHandle): number {
  return readNumber(db, CYCLE_KEY) ?? 0;
}

export function operationStats(db: SqliteHandle, name: string): OperationStats {
  const lastRunAt = getMeta(db, key(name, 'last_run_at'));
  const selectedCycle = readNumber(db, key(name, 'selected_cycle'));
  const pendingMeasure = readNumber(db, key(name, 'pending_measure'));
  const lastDurationMs = readNumber(db, key(name, 'last_duration_ms'));
  return {
    name,
    runs: readNumber(db, key(name, 'runs')) ?? EMPTY_STATS.runs,
    improved: readNumber(db, key(name, 'improved')) ?? EMPTY_STATS.improved,
    unchanged: readNumber(db, key(name, 'unchanged')) ?? EMPTY_STATS.unchanged,
    failed: readNumber(db, key(name, 'failed')) ?? EMPTY_STATS.failed,
    unmeasured: readNumber(db, key(name, 'unmeasured')) ?? EMPTY_STATS.unmeasured,
    durationRuns: readNumber(db, key(name, 'duration_runs')) ?? 0,
    durationTotalMs: readNumber(db, key(name, 'duration_total_ms')) ?? 0,
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    ...(lastDurationMs === undefined ? {} : { lastDurationMs }),
    ...(selectedCycle === undefined ? {} : { selectedCycle }),
    ...(pendingMeasure === undefined ? {} : { pendingMeasure }),
  };
}

/**
 * What a run of this operation typically costs, or undefined until one has been timed. The mean
 * rather than the last reading: one operation's cost varies with how much work its batch found,
 * and a scheduler comparing catalog costs needs the shape of the whole record.
 */
export function meanOperationDurationMs(stats: OperationStats): number | undefined {
  if (stats.durationRuns <= 0) {
    return undefined;
  }
  return stats.durationTotalMs / stats.durationRuns;
}

export function listOperationStats(
  db: SqliteHandle,
  names: readonly string[],
): readonly OperationStats[] {
  return names.map((name) => operationStats(db, name));
}

/** Stamped whether or not the run did anything, so starvation resets on selection, not on success. */
export function recordOperationSelected(db: SqliteHandle, name: string, cycle: number): void {
  setMeta(db, key(name, 'selected_cycle'), String(cycle));
}

export function recordOperationRun(db: SqliteHandle, name: string, at: string): void {
  setMeta(db, key(name, 'last_run_at'), at);
}

/**
 * How long one run took, recorded whatever it did: a failure that took a minute is exactly the
 * cost a scheduler needs to know about. Read and both writes are one unit for the same reason
 * the resolution tallies are, so the count and the total cannot increment off different bases.
 */
export function recordOperationDuration(db: SqliteHandle, name: string, durationMs: number): void {
  const bounded = Math.max(0, durationMs);
  db.transaction(() => {
    const current = operationStats(db, name);
    setMeta(db, key(name, 'duration_runs'), String(current.durationRuns + 1));
    setMeta(db, key(name, 'duration_total_ms'), String(current.durationTotalMs + bounded));
    setMeta(db, key(name, 'last_duration_ms'), String(bounded));
  }).immediate();
}

export function recordOperationResolution(
  db: SqliteHandle,
  name: string,
  resolution: OperationResolution,
): void {
  // The read and both writes are one unit: split across a concurrent resolution, `runs` and
  // the per-resolution tally increment off different bases and stop summing to each other.
  db.transaction(() => {
    const current = operationStats(db, name);
    setMeta(db, key(name, 'runs'), String(current.runs + 1));
    setMeta(db, key(name, resolution), String(current[resolution] + 1));
  }).immediate();
}

/**
 * The reading taken before a run, held until a later snapshot can be compared against it. One
 * per operation: a second run before the first resolved overwrites it, which is the honest
 * answer, since the older reading no longer describes the state the newer run started from.
 */
export function setPendingMeasure(db: SqliteHandle, name: string, measure: number): void {
  setMeta(db, key(name, 'pending_measure'), String(measure));
}

export function clearPendingMeasure(db: SqliteHandle, name: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key(name, 'pending_measure'));
}

/**
 * Claims one operation's time bucket. True means this process owns the window and must run the
 * operation; false means the key was already there, so either another instance has it or this
 * one already ran it, and either way the work must not happen twice.
 *
 * The claim lands before the run rather than after it. A crash mid-operation therefore holds
 * the window until it rolls over, which is the trade the safety rule asks for: maintenance
 * that skips a window costs one cadence, and maintenance that runs twice on a partial first
 * pass costs whatever the operation was halfway through.
 */
export function claimOperationBucket(
  db: SqliteHandle,
  bucketKey: string,
  summary?: unknown,
): boolean {
  const result = db
    .prepare(
      `INSERT INTO ops_ledger (key, applied_at, summary_json) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(
      bucketKey,
      new Date().toISOString(),
      summary === undefined ? null : JSON.stringify(summary),
    );
  return result.changes === 1;
}
