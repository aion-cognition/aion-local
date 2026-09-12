import {
  introspectionCycle,
  introspectionOperations,
  latestLedgerEntry,
  listOperationStats,
  meanOperationDurationMs,
  OPERATION_LEDGER_PREFIX,
  type Config,
  type OperationStats,
  type SqliteHandle,
} from '@aion/core';

import { ageOf } from './format.js';
import type { Writer } from './output.js';

/**
 * The maintenance section of `aion status` and `aion stats`: what each registered operation has
 * been doing, and what its most recent bucket claim wrote to the ops ledger.
 *
 * Lifted out of `snapshot.ts` unchanged when that file reached the 500-line cap, on the pattern
 * the other sections already follow: the section owns its own reading and its own renderer, so
 * `snapshot.ts` collects the substrate and does not also know how any one section reads.
 */

/**
 * One maintenance operation's record: the counters the engine keeps, plus what its most
 * recent bucket claim wrote to the ops ledger. The two come from different places on purpose.
 * The counters answer how the operation has been doing over its life; the ledger entry is the
 * evidence that one particular window ran and what it did in it.
 */
export type MaintenanceOperationReading = {
  readonly stats: OperationStats;
  readonly lastStatus?: string;
  readonly lastItemsAffected?: number;
  readonly lastDetail?: string;
};

export type MaintenanceSnapshot = {
  /** Ticks the loop has taken. Starvation is measured in these, not in wall time. */
  readonly cycle: number;
  readonly operations: readonly MaintenanceOperationReading[];
};

/** The engine writes this object as the ledger summary; a hand-edited row may not match it. */
type LedgerSummary = {
  readonly status?: unknown;
  readonly itemsAffected?: unknown;
  readonly detail?: unknown;
};

function readLedgerSummary(summary: unknown): LedgerSummary {
  if (typeof summary !== 'object' || summary === null) {
    return {};
  }
  return summary;
}

/**
 * Reads the catalog rather than a stored list of names, so an operation registered in
 * `introspectionOperations` shows up here with no second place to remember to add it. One that
 * has never run reports zeroes, which is the honest reading and not an omission.
 */
export function collectMaintenance(db: SqliteHandle, config: Config): MaintenanceSnapshot {
  const names = introspectionOperations(config).map((operation) => operation.name);
  const operations = listOperationStats(db, names).map((stats) => {
    const entry = latestLedgerEntry(db, `${OPERATION_LEDGER_PREFIX}${stats.name}:`);
    const summary = readLedgerSummary(entry?.summary);
    return {
      stats,
      ...(typeof summary.status === 'string' ? { lastStatus: summary.status } : {}),
      ...(typeof summary.itemsAffected === 'number'
        ? { lastItemsAffected: summary.itemsAffected }
        : {}),
      ...(typeof summary.detail === 'string' ? { lastDetail: summary.detail } : {}),
    };
  });
  return { cycle: introspectionCycle(db), operations };
}

const OPERATION_NAME_WIDTH = 24;

/**
 * One line per registered operation. An operation with no runs says so rather than printing a
 * row of zeroes that reads like a measurement, since "never selected" and "selected and did
 * nothing" are different answers to the only question this section exists for.
 */
export function renderMaintenance(snapshot: MaintenanceSnapshot, now: number, write: Writer): void {
  write('');
  write('maintenance');
  write(
    `  cycle ${String(snapshot.cycle)}, ${String(snapshot.operations.length)} operations registered`,
  );
  for (const reading of snapshot.operations) {
    const { stats } = reading;
    const name = stats.name.padEnd(OPERATION_NAME_WIDTH);
    if (stats.lastRunAt === undefined) {
      write(`  ${name} never selected`);
      continue;
    }
    const age = ageOf(Math.max(0, now - Date.parse(stats.lastRunAt)));
    const affected =
      reading.lastItemsAffected === undefined
        ? ''
        : ` (${String(reading.lastItemsAffected)} affected)`;
    const mean = meanOperationDurationMs(stats);
    const cost = mean === undefined ? '' : `  ~${(mean / 1000).toFixed(1)}s/run`;
    write(
      `  ${name} runs ${String(stats.runs)}  improved ${String(stats.improved)}  ` +
        `unchanged ${String(stats.unchanged)}  failed ${String(stats.failed)}  ` +
        `unmeasured ${String(stats.unmeasured)}${cost}  ` +
        `last ${age} ago ${reading.lastStatus ?? 'unrecorded'}${affected}`,
    );
  }
}
