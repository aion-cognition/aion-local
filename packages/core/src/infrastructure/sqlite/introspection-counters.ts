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

/** Whether an operation moved the metric it declared, once the next snapshot could see it. */
export type OperationResolution = 'improved' | 'unchanged' | 'failed';

export type OperationStats = {
  readonly name: string;
  /** Runs that have resolved. A run awaiting its next-cycle measurement is not counted yet. */
  readonly runs: number;
  readonly improved: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly lastRunAt?: string;
  /** The cycle this operation was last selected on; absent until it has been. */
  readonly selectedCycle?: number;
  /** The metric reading taken before the last run, waiting on the next snapshot to score it. */
  readonly pendingMeasure?: number;
};

const EMPTY_STATS = { runs: 0, improved: 0, unchanged: 0, failed: 0 } as const;

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
  return {
    name,
    runs: readNumber(db, key(name, 'runs')) ?? EMPTY_STATS.runs,
    improved: readNumber(db, key(name, 'improved')) ?? EMPTY_STATS.improved,
    unchanged: readNumber(db, key(name, 'unchanged')) ?? EMPTY_STATS.unchanged,
    failed: readNumber(db, key(name, 'failed')) ?? EMPTY_STATS.failed,
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    ...(selectedCycle === undefined ? {} : { selectedCycle }),
    ...(pendingMeasure === undefined ? {} : { pendingMeasure }),
  };
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

export function recordOperationResolution(
  db: SqliteHandle,
  name: string,
  resolution: OperationResolution,
): void {
  const current = operationStats(db, name);
  setMeta(db, key(name, 'runs'), String(current.runs + 1));
  setMeta(db, key(name, resolution), String(current[resolution] + 1));
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
export function claimOperationBucket(db: SqliteHandle, bucketKey: string, summary?: unknown): boolean {
  const result = db
    .prepare(
      `INSERT INTO ops_ledger (key, applied_at, summary_json) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(bucketKey, new Date().toISOString(), summary === undefined ? null : JSON.stringify(summary));
  return result.changes === 1;
}
