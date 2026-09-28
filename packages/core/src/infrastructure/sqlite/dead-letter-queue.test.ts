import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReflectionQueueClaimant } from './claim.js';
import { SqliteStore } from './database.js';
import {
  countDeadLetterAttention,
  deadLetterSeenKey,
  hasUntriedConditions,
  listExhaustedJobs,
  listRetriedExhaustedJobs,
  recordDeadLetterRetry,
  relaneDeadLetterJob,
  type RetryConditions,
} from './dead-letter-queue.js';
import { markLedgerApplied } from './ops-ledger.js';
import { enqueueReflectionJob, type ReflectionLane } from './reflection-queue.js';

const MAX_ATTEMPTS = 5;

const CONDITIONS: RetryConditions = {
  build: 'build-a',
  readinessPolicy: 1,
  generationRoute: 'anthropic:claude-haiku-4-5',
  processingGeneration: 1,
  referenceVersion: 1,
};

describe('dead letter queue', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-dead-letter-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function enqueue(sessionId: string, lane: ReflectionLane, enqueuedAt: string): string {
    const id = enqueueReflectionJob(store.db, 'integrate', { enqueuedAt }, { lane, sessionId });
    store.db
      .prepare('UPDATE reflection_queue SET enqueued_at = ? WHERE id = ?')
      .run(enqueuedAt, id);
    return id;
  }

  function exhaust(id: string): string {
    store.db.prepare('UPDATE reflection_queue SET attempts = ? WHERE id = ?').run(MAX_ATTEMPTS, id);
    return id;
  }

  it('leaves a row it has already retried out of the batch', () => {
    const spent = exhaust(enqueue('agent', 'bulk', '2026-08-01T00:00:00.000Z'));
    const fresh = exhaust(enqueue('agent', 'bulk', '2026-08-02T00:00:00.000Z'));
    markLedgerApplied(store.db, deadLetterSeenKey(spent), {});

    expect(listExhaustedJobs(store.db, MAX_ATTEMPTS, 1).map((job) => job.id)).toEqual([fresh]);
    expect(countDeadLetterAttention(store.db, MAX_ATTEMPTS)).toBe(1);
  });

  it('keeps every retry a row had, and reads an older marker as one retry with no conditions', () => {
    const legacy = exhaust(enqueue('agent', 'bulk', '2026-08-01T00:00:00.000Z'));
    const kept = exhaust(enqueue('agent', 'bulk', '2026-08-02T00:00:00.000Z'));
    markLedgerApplied(store.db, deadLetterSeenKey(legacy), { jobType: 'integrate' });
    const job = { id: kept, jobType: 'integrate', enqueuedAt: '', sourceId: undefined };
    recordDeadLetterRetry(store.db, job, CONDITIONS, new Date('2026-08-03T00:00:00.000Z'));
    const later = { ...CONDITIONS, build: 'build-b' };
    recordDeadLetterRetry(store.db, job, later, new Date('2026-08-04T00:00:00.000Z'));

    const [first, second] = listRetriedExhaustedJobs(store.db, MAX_ATTEMPTS);

    expect(first?.id).toBe(legacy);
    expect(first?.retries).toHaveLength(1);
    expect(first?.retries[0]?.conditions).toBeUndefined();
    expect(second?.retries).toEqual([
      { at: '2026-08-03T00:00:00.000Z', conditions: CONDITIONS },
      { at: '2026-08-04T00:00:00.000Z', conditions: later },
    ]);
  });

  it('offers one cycle per distinct set of conditions, and one to a retry nobody recorded', () => {
    const tried = [{ at: 'a', conditions: CONDITIONS }];

    expect(hasUntriedConditions(tried, CONDITIONS)).toBe(false);
    expect(hasUntriedConditions(tried, { ...CONDITIONS, referenceVersion: 2 })).toBe(true);
    expect(hasUntriedConditions([{ at: 'a' }], CONDITIONS)).toBe(true);
    expect(hasUntriedConditions([{ at: 'a' }, ...tried], CONDITIONS)).toBe(false);
  });

  it('claims a relaned row behind the bulk backlog its session already had', () => {
    const first = enqueue('agent', 'bulk', '2026-08-01T00:00:00.000Z');
    const second = enqueue('agent', 'bulk', '2026-08-01T00:00:01.000Z');
    const stuck = exhaust(enqueue('agent', 'interactive', '2026-08-01T00:00:02.000Z'));

    expect(relaneDeadLetterJob(store.db, stuck)).toBe(true);

    const claimant = new ReflectionQueueClaimant();
    const order = [
      claimant.claimNext(store.db, MAX_ATTEMPTS)?.id,
      claimant.claimNext(store.db, MAX_ATTEMPTS)?.id,
      claimant.claimNext(store.db, MAX_ATTEMPTS)?.id,
    ];

    expect(order).toEqual([first, second, stuck]);
  });
});
