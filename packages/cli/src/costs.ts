import {
  batchWorkCounts,
  estimateApiCost,
  readSpendDay,
  readSubstratePairing,
  summarizeApiCalls,
  type ApiUsageGroup,
  type SqliteHandle,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

const SPEC: ArgSpec = {
  command: 'costs',
  usage: 'aion costs [--days N]',
  options: [{ flag: '--days', takesValue: true }],
};
const DEFAULT_DAYS = 7;
const DAY_MS = 86_400_000;

function parseDays(argv: readonly string[]): number {
  const { values } = parseArgs(SPEC, argv);
  const value = values.get('--days');
  const days = value === undefined ? DEFAULT_DAYS : Number(value);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 100_000) {
    throw new CliUsageError('--days must be a positive integer no greater than 100000');
  }
  return days;
}

/**
 * A usage parse failure leaves that group's token counts unknown, so its denominator is
 * unknown too. Only the groups carrying one lose their share.
 */
function cacheShare(row: ApiUsageGroup): string {
  if (row.usageErrors > 0) {
    return 'unavailable';
  }
  const input = row.inputTokens + row.cacheCreationTokens + row.cacheReadTokens;
  if (input === 0) {
    return 'no-input';
  }
  return `${((row.cacheReadTokens / input) * 100).toFixed(1)}%`;
}

/**
 * The reasoning tokens a group can account for, and whether that is all of them. A response
 * whose usage block carried no breakdown left its share unknown rather than at zero, so a group
 * holding one prints what it can add and says the rest is missing instead of quietly under-
 * reporting the reasoning.
 */
function reasoningShare(row: ApiUsageGroup): string {
  if (row.thinkingTokens === null) {
    return 'unavailable';
  }
  const known = String(row.thinkingTokens);
  return row.thinkingUnknown > 0 ? `${known}+unknown` : known;
}

function renderGroups(title: string, rows: readonly ApiUsageGroup[], write: Writer): void {
  write(title);
  // `thinking` sits beside `output` rather than after the cache columns, because it is a share
  // of the output count and a reader adding the two would double-count the reasoning. `rate` is
  // the rate card the group billed on: the token counts are what the model read and wrote either
  // way, and the batch discount is in the dollars alone.
  write(
    'group  model  rate  calls  input  output  thinking  cache-write  cache-read  cache-share  usage-errors  estimated USD',
  );
  for (const row of rows) {
    const cost = estimateApiCost(row);
    write(
      [
        row.key,
        row.model,
        row.pricingTier,
        row.calls,
        row.inputTokens,
        row.outputTokens,
        reasoningShare(row),
        row.cacheCreationTokens,
        row.cacheReadTokens,
        cacheShare(row),
        row.usageErrors,
        (cost === undefined ? 'unpriced' : `$${cost.toFixed(6)}`) +
          (row.usageErrors > 0 ? ' + unknown' : ''),
      ].join('  '),
    );
  }
}

/**
 * Today against the ceiling, which is the number that decides whether anything else runs.
 *
 * It is the reservation ledger rather than the bill above: a request in flight has committed its
 * conservative maximum and nothing has been charged for it yet, and the ceiling is consulted
 * before dispatch, so what it reads is what a caller asking to spend more would be measured on.
 */
function renderCeiling(db: SqliteHandle, ceilingUsd: number, write: Writer): void {
  const day = readSpendDay(db, new Date());
  const unpriced =
    day.unpriced === 0
      ? ''
      : `; ${String(day.unpriced)} dispatch(es) on an unpriced model bound nothing`;
  write(
    `today against the ceiling: $${day.committedUsd.toFixed(6)} of $${ceilingUsd.toFixed(2)} ` +
      `committed (${String(day.inFlight)} request(s) in flight holding ` +
      `$${day.inFlightUsd.toFixed(6)})${unpriced}`,
  );
}

/**
 * What has been submitted and not yet billed. A batch runs for up to 24 hours, so the total
 * above is what has landed rather than what is owed, and a reader deciding whether to spend more
 * needs the commitment beside it. Batched requests bill at half the ordinary rate, which is why
 * the outstanding count is a count and not a price.
 */
function renderOutstanding(db: SqliteHandle, write: Writer): void {
  const substrateId = readSubstratePairing(db)?.substrateId;
  if (substrateId === undefined) {
    return;
  }
  const counts = batchWorkCounts(db, substrateId);
  if (counts.pending === 0 && counts.submitted === 0) {
    return;
  }
  write(
    `batch commitments: ${String(counts.submitted)} request(s) outstanding at the remote, ` +
      `${String(counts.pending)} queued to send; neither is billed above yet`,
  );
}

export function runCosts(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseDays,
    run: (substrate, days) => {
      const now = new Date();
      const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const since = new Date(startOfToday - (days - 1) * DAY_MS);
      const until = new Date(now.getTime() + 1);
      const report = summarizeApiCalls(substrate.db(), since, until);
      write(`API costs since ${since.toISOString()} (UTC; today included)`);
      if (report.days.length === 0) {
        write('no metered API calls in this period');
        renderCeiling(substrate.db(), substrate.config.anthropic.dailyCeilingUsd, write);
        renderOutstanding(substrate.db(), write);
        return Promise.resolve(0);
      }
      renderGroups('per day', report.days, write);
      renderGroups('per surface', report.surfaces, write);
      let priced = 0;
      let reads = 0;
      let input = 0;
      let usageErrors = 0;
      const unpriced = new Set<string>();
      for (const row of report.days) {
        const cost = estimateApiCost(row);
        if (cost === undefined) {
          unpriced.add(row.model);
        } else {
          priced += cost;
        }
        reads += row.cacheReadTokens;
        usageErrors += row.usageErrors;
        input += row.inputTokens + row.cacheCreationTokens + row.cacheReadTokens;
      }
      const unknownCharges =
        usageErrors === 0 ? '' : ` + unknown charges (${String(usageErrors)} usage parse failures)`;
      write(
        `estimated total: $${priced.toFixed(6)}${unpriced.size === 0 ? '' : ` + unpriced: ${[...unpriced].join(', ')}`}${unknownCharges}`,
      );
      write(
        usageErrors > 0
          ? 'cache effectiveness unavailable: usage parse failures'
          : `cache effectiveness: ${String(reads)} / ${String(input)} input tokens (${(input === 0 ? 0 : (reads / input) * 100).toFixed(1)}%)`,
      );
      renderCeiling(substrate.db(), substrate.config.anthropic.dailyCeilingUsd, write);
      renderOutstanding(substrate.db(), write);
      return Promise.resolve(0);
    },
  });
}
