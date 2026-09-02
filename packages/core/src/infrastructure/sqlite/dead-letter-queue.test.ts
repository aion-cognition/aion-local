import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReflectionQueueClaimant } from './claim.js';
import { SqliteStore } from './database.js';
import {
  countDeadLetterAttention,
  deadLetterSeenKey,
  listExhaustedJobs,
  relaneDeadLetterJob,
} from './dead-letter-queue.js';
import { markLedgerApplied } from './ops-ledger.js';
import { enqueueReflectionJob, type ReflectionLane } from './reflection-queue.js';

const MAX_ATTEMPTS = 5;

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
