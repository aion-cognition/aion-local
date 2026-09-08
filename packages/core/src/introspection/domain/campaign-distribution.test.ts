import { describe, expect, it } from 'vitest';

import { bucketCounts, checkLimit, distributionOf } from './campaign-distribution.js';

describe('the shape of a measured population', () => {
  it('reports nothing for an empty population rather than a row of zeroes', () => {
    expect(distributionOf([])).toBe(undefined);
  });

  it('reports a value the population actually holds at each percentile', () => {
    const distribution = distributionOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(distribution).toEqual({
      count: 10,
      total: 55,
      min: 1,
      p50: 5,
      p90: 9,
      p99: 10,
      max: 10,
    });
  });

  it('handles a single-record population', () => {
    expect(distributionOf([7])).toMatchObject({ count: 1, min: 7, p50: 7, max: 7 });
  });
});

describe('checking a corpus against a proposed limit', () => {
  const records = [
    { key: 'a', value: 10 },
    { key: 'b', value: 100 },
    { key: 'c', value: 250 },
  ];

  it('names the records over the line, largest first', () => {
    const report = checkLimit(records, 50, 'bytes');
    expect(report.exceeding).toEqual([
      { key: 'c', value: 250 },
      { key: 'b', value: 100 },
    ]);
    expect(report.exceedingCount).toBe(2);
  });

  it('treats a record exactly at the limit as fitting', () => {
    expect(checkLimit(records, 250, 'bytes').exceeding).toEqual([]);
  });

  it('caps how many it names while still counting all of them', () => {
    const report = checkLimit(records, 5, 'bytes', 1);
    expect(report.exceeding).toHaveLength(1);
    expect(report.exceedingCount).toBe(3);
  });

  it('carries the population shape beside the exceedances', () => {
    expect(checkLimit(records, 50, 'bytes').distribution).toMatchObject({ count: 3, max: 250 });
  });
});

describe('bucketing a population', () => {
  it('counts each value in the first bucket its value fits', () => {
    const counts = bucketCounts([1, 5, 50, 5000], [10, 100]);
    expect(counts.get('0-10')).toBe(2);
    expect(counts.get('10-100')).toBe(1);
    expect(counts.get('100+')).toBe(1);
  });

  it('keeps an empty bucket in the report', () => {
    expect(bucketCounts([1], [10, 100]).get('10-100')).toBe(0);
  });
});
