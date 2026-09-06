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

function renderGroups(title: string, rows: readonly ApiUsageGroup[], write: Writer): void {
  write(title);
  write('group  model  calls  input  output  cache-write  cache-read  estimated USD');
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
        cost === undefined ? 'unpriced' : `$${cost.toFixed(6)}`,
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
      const unpriced = new Set<string>();
      for (const row of report.days) {
        const cost = estimateApiCost(row);
        if (cost === undefined) {
          unpriced.add(row.model);
        } else {
          priced += cost;
        }
        reads += row.cacheReadTokens;
        input += row.inputTokens + row.cacheCreationTokens + row.cacheReadTokens;
      }
      write(
        `estimated total: $${priced.toFixed(6)}${unpriced.size === 0 ? '' : ` + unpriced: ${[...unpriced].join(', ')}`}`,
      );
      write(
        `cache effectiveness: ${String(reads)} / ${String(input)} input tokens (${(input === 0 ? 0 : (reads / input) * 100).toFixed(1)}%)`,
      );
      return Promise.resolve(0);
    },
  });
}
