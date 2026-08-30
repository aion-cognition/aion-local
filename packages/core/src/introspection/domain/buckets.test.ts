import { describe, expect, it } from 'vitest';

import { bucketStamp, operationBucketKey, OPERATION_BUCKETS } from './buckets.js';

const AT = new Date('2026-08-29T14:37:12.500Z');

describe('bucketStamp', () => {
  it('names the calendar window, not the instant', () => {
    expect(bucketStamp('day', AT)).toBe('2026-08-29');
    expect(bucketStamp('hour', AT)).toBe('2026-08-29T14');
    expect(bucketStamp('quarter-hour', AT)).toBe('2026-08-29T14:30');
  });

  it('holds across a whole quarter-hour and turns over at its edge', () => {
    const early = new Date('2026-08-29T14:30:00.000Z');
    const late = new Date('2026-08-29T14:44:59.999Z');
    const next = new Date('2026-08-29T14:45:00.000Z');
    expect(bucketStamp('quarter-hour', early)).toBe(bucketStamp('quarter-hour', late));
    expect(bucketStamp('quarter-hour', next)).not.toBe(bucketStamp('quarter-hour', late));
  });

  it('reads the same in every zone, since two instances may not share one', () => {
    const utcNoon = new Date('2026-08-29T12:00:00.000Z');
    expect(bucketStamp('day', utcNoon)).toBe('2026-08-29');
    expect(bucketStamp('hour', new Date('2026-08-29T23:59:59.000Z'))).toBe('2026-08-29T23');
  });

  it('pads every field to a sortable width', () => {
    const early = new Date('2026-01-02T03:04:00.000Z');
    expect(bucketStamp('quarter-hour', early)).toBe('2026-01-02T03:00');
  });
});

describe('operationBucketKey', () => {
  it('carries the operation, the bucket, and the window', () => {
    expect(operationBucketKey('memory_decay', 'day', AT)).toBe('intro:memory_decay:day:2026-08-29');
  });

  it('gives every bucket its own key space, so a re-bucketed operation starts fresh', () => {
    const keys = OPERATION_BUCKETS.map((bucket) => operationBucketKey('op', bucket, AT));
    expect(new Set(keys).size).toBe(OPERATION_BUCKETS.length);
  });
});
