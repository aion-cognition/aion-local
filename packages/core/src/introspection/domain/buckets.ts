/**
 * Time-bucketed idempotency keys. Every maintenance operation runs at most once per bucket,
 * and the bucket is calendar-aligned rather than measured from the last run, so two service
 * instances with different start times and different tick phases still derive the same key for
 * the same window and exactly one of them claims it.
 *
 * The bucket name is part of the key. Changing an operation's bucket therefore starts a new
 * key space instead of colliding with stamps written under the old granularity.
 */

export const OPERATION_BUCKETS = ['quarter-hour', 'hour', 'day'] as const;

export type OperationBucket = (typeof OPERATION_BUCKETS)[number];

const QUARTER_HOUR_MINUTES = 15;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** UTC throughout: a local-time stamp would give two instances in different zones different windows. */
export function bucketStamp(bucket: OperationBucket, now: Date): string {
  const day = `${String(now.getUTCFullYear())}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  if (bucket === 'day') {
    return day;
  }
  const hour = `${day}T${pad(now.getUTCHours())}`;
  if (bucket === 'hour') {
    return hour;
  }
  const minute = Math.floor(now.getUTCMinutes() / QUARTER_HOUR_MINUTES) * QUARTER_HOUR_MINUTES;
  return `${hour}:${pad(minute)}`;
}

export const OPERATION_LEDGER_PREFIX = 'intro:';

export function operationBucketKey(name: string, bucket: OperationBucket, now: Date): string {
  return `${OPERATION_LEDGER_PREFIX}${name}:${bucket}:${bucketStamp(bucket, now)}`;
}
