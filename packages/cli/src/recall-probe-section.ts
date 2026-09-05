import type { RecallProbeCounters } from '@aion/core';

import type { Writer } from './output.js';

/**
 * The two numbers the recall self-probe produces: how often the substrate hands back an
 * experience it was told about, and how much of what it served was used afterward. They are the
 * closest thing here to a measurement of whether the whole loop works, so they print as their
 * own section rather than inside the cadence lines, which count calls and say nothing about
 * whether the answers were right.
 *
 * It renders here rather than in `snapshot.ts` to keep that file under the size rule.
 */

/** The longer of the two labels, so both counts start at one column. */
const PROBE_LABEL_WIDTH = 14;

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function label(text: string): string {
  return text.padEnd(PROBE_LABEL_WIDTH);
}

/**
 * Nothing probed says so. Zero hits out of zero questions is not a substrate that forgot
 * everything, and printing it as `0.0%` would read like one.
 */
function hitLine(counters: RecallProbeCounters): string {
  if (counters.hitRate === undefined) {
    return `  ${label('recalled')} nothing probed yet`;
  }
  return (
    `  ${label('recalled')} ${String(counters.hits)} of ${String(counters.samples)} ` +
    `asked back  ${percent(counters.hitRate)}`
  );
}

/**
 * The served reading is the latest one rather than a total, so it prints when it was taken.
 * A run that found no served row old enough to judge says that, since it is a fact about the
 * sessions on file and not about how memory is being used.
 */
function servedLine(counters: RecallProbeCounters): string {
  const { served } = counters;
  if (served === undefined) {
    return `  ${label('referenced')} not measured yet`;
  }
  if (served.rate === undefined) {
    return `  ${label('referenced')} no served item older than a day (${served.measuredAt})`;
  }
  return (
    `  ${label('referenced')} ${String(served.referenced)} of ${String(served.items)} ` +
    `served  ${percent(served.rate)} (${served.measuredAt})`
  );
}

export function renderRecallProbe(counters: RecallProbeCounters, write: Writer): void {
  write('');
  write('recall self-probe');
  write(hitLine(counters));
  write(servedLine(counters));
}
