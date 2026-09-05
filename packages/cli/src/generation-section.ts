import type { GenerationCounters, GenerationRouteStat } from '@aion/core';

import type { Writer } from './output.js';

/**
 * What the substrate's model calls have done, per route. Beside the pack-method table because
 * it answers the other half of the same question: that one says which method found what a pack
 * served, this one says whether the calls behind it are answering at all.
 *
 * It renders here rather than in `snapshot.ts` to keep that file under the size rule.
 */

/** The longest route label, so every count starts at one column. */
const ROUTE_NAME_WIDTH = 21;

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * A route nothing has called says so. Zero failures out of zero calls is not a clean record,
 * and printing it as `0.0% failed` would read like one.
 */
function describeRoute(route: GenerationRouteStat): string {
  const label = `${route.role} via ${route.provider}`.padEnd(ROUTE_NAME_WIDTH);
  const calls = String(route.calls).padStart(6);
  if (route.failureRate === undefined) {
    return `  ${label} ${calls}  never called`;
  }
  const cost =
    route.meanDurationMs === undefined
      ? ''
      : `  ~${(route.meanDurationMs / 1000).toFixed(1)}s/call`;
  return `  ${label} ${calls}  ${percent(route.failureRate)} failed${cost}`;
}

export function renderGeneration(counters: GenerationCounters, write: Writer): void {
  write('');
  write('generation by route');
  const headline =
    counters.failureRate === undefined
      ? 'no generations yet'
      : `${percent(counters.failureRate)} failed`;
  write(
    `  ${'all routes'.padEnd(ROUTE_NAME_WIDTH)} ${String(counters.calls).padStart(6)}  ${headline}`,
  );
  for (const route of counters.routes) {
    write(describeRoute(route));
  }
}
