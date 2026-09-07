import { estimateApiCost, summarizeApiCalls, type ApiUsageGroup } from '@aion/core';

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

function renderGroups(title: string, rows: readonly ApiUsageGroup[], write: Writer): void {
  write(title);
  write(
    'group  model  calls  input  output  cache-write  cache-read  cache-share  usage-errors  estimated USD',
  );
  for (const row of rows) {
    const cost = estimateApiCost(row);
    write(
      [
        row.key,
        row.model,
        row.calls,
        row.inputTokens,
        row.outputTokens,
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
      return Promise.resolve(0);
    },
  });
}
