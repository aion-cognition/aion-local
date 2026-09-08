/**
 * Distributions and named exceedances for the corpus measurements a proposed limit is checked
 * against.
 *
 * A limit is accepted or rejected on what the stored corpus actually holds, so the report
 * needs the shape of the population and the identity of every record over the line. A mean
 * hides the one record that would be refused, and a count of exceedances does not say which
 * record to look at, so both the percentiles and the named rows are reported.
 */

export type Distribution = {
  readonly count: number;
  readonly total: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
};

/**
 * Nearest-rank percentiles on a sorted copy: the value at position `ceil(p * n)`, which is
 * always a value the corpus actually holds rather than an interpolation between two records.
 */
function percentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? 0;
}

/** Undefined for an empty population, which is not the same as a population of zeroes. */
export function distributionOf(values: readonly number[]): Distribution | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    total: sorted.reduce((sum, value) => sum + value, 0),
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export type MeasuredRecord = {
  readonly key: string;
  readonly value: number;
};

export type LimitReport = {
  readonly limit: number;
  readonly unit: string;
  readonly distribution?: Distribution;
  /** Largest first, so the worst case reads at the top. */
  readonly exceeding: readonly MeasuredRecord[];
  readonly exceedingCount: number;
};

/**
 * How a corpus sits against one proposed bound. The bound is inclusive: a record exactly at
 * the limit fits, and only a record over it is named.
 */
export function checkLimit(
  records: readonly MeasuredRecord[],
  limit: number,
  unit: string,
  namedCap = 20,
): LimitReport {
  const exceeding = records
    .filter((record) => record.value > limit)
    .sort((left, right) => right.value - left.value);
  const distribution = distributionOf(records.map((record) => record.value));
  return {
    limit,
    unit,
    ...(distribution === undefined ? {} : { distribution }),
    exceeding: exceeding.slice(0, namedCap),
    exceedingCount: exceeding.length,
  };
}

/** Counts per bucket, oldest bucket first, for a population reported as a histogram. */
export function bucketCounts(
  values: readonly number[],
  edges: readonly number[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const sortedEdges = [...edges].sort((left, right) => left - right);
  for (const [index, edge] of sortedEdges.entries()) {
    const lower = index === 0 ? 0 : (sortedEdges[index - 1] ?? 0);
    counts.set(`${String(lower)}-${String(edge)}`, 0);
  }
  const last = sortedEdges[sortedEdges.length - 1];
  const overflow = last === undefined ? '0+' : `${String(last)}+`;
  counts.set(overflow, 0);

  for (const value of values) {
    const edgeIndex = sortedEdges.findIndex((edge) => value <= edge);
    if (edgeIndex === -1) {
      counts.set(overflow, (counts.get(overflow) ?? 0) + 1);
      continue;
    }
    const lower = edgeIndex === 0 ? 0 : (sortedEdges[edgeIndex - 1] ?? 0);
    const key = `${String(lower)}-${String(sortedEdges[edgeIndex] ?? 0)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
