import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReflectionQueueClaimant } from './claim.js';
import { SqliteStore } from './database.js';
import {
  countQueueJobs,
  countQueueJobsByLane,
  dropUnclaimedJobs,
  listQueueJobs,
  promoteJobs,
} from './reflection-queue-admin.js';
import { enqueueReflectionJob, listReflectionJobs, type ReflectionLane } from './reflection-queue.js';

describe('reflection queue administration', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-queue-admin-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function enqueue(sessionId: string, lane: ReflectionLane, label: string): string {
    return enqueueReflectionJob(store.db, 'integrate', { label }, { lane, sessionId });
  }

  function seed(): void {
    enqueue('flood', 'bulk', 'flood-0');
    enqueue('flood', 'bulk', 'flood-1');
    enqueue('agent', 'interactive', 'live-0');
    enqueue('other', 'bulk', 'other-0');
  }

  it('filters a listing by session and by lane', () => {
    seed();

    expect(listQueueJobs(store.db, { sessionId: 'flood' })).toHaveLength(2);
    expect(listQueueJobs(store.db, { lane: 'interactive' })).toHaveLength(1);
    expect(listQueueJobs(store.db, { lane: 'bulk', sessionId: 'other' })).toHaveLength(1);
    expect(listQueueJobs(store.db, {}, 2)).toHaveLength(2);
  });

  it('counts claimed, unclaimed, exhausted and the oldest unclaimed arrival', () => {
    seed();
    const exhausted = enqueue('agent', 'interactive', 'stuck');
    store.db.prepare('UPDATE reflection_queue SET attempts = 5 WHERE id = ?').run(exhausted);
    new ReflectionQueueClaimant().claimNext(store.db, 5);

    const counts = countQueueJobs(store.db, {}, 5);

    expect(counts).toMatchObject({ total: 5, claimed: 1, unclaimed: 4, exhausted: 1 });
    expect(counts.oldestUnclaimedAt).toEqual(expect.any(String));
  });

  it('counts pending depth per lane', () => {
    seed();

    expect(countQueueJobsByLane(store.db)).toEqual(
      new Map([
        ['bulk', 3],
        ['interactive', 1],
      ]),
    );
  });

  // A claimed row belongs to a worker running it right now. Deleting it under that worker
  // strands the episode with no queue row and no ledger key, which is the state reconcile
  // exists to repair rather than to cause.
  it('drops only unclaimed rows and leaves a claimed one alone', () => {
    seed();
    const claimed = new ReflectionQueueClaimant().claimNext(store.db);

    const dropped = dropUnclaimedJobs(store.db, {});

    expect(dropped).toBe(3);
    expect(listReflectionJobs(store.db).map((job) => job.id)).toEqual([claimed?.id]);
  });

  it('drops one session without touching another', () => {
    seed();

    expect(dropUnclaimedJobs(store.db, { sessionId: 'flood' })).toBe(2);
    expect(listReflectionJobs(store.db)).toHaveLength(2);
  });

  it('promotes a session out of the bulk lane and counts only the rows that moved', () => {
    seed();

    expect(promoteJobs(store.db, { sessionId: 'flood' })).toBe(2);
    expect(promoteJobs(store.db, { sessionId: 'flood' })).toBe(0);
    expect(listQueueJobs(store.db, { lane: 'interactive' })).toHaveLength(3);
  });

  it('leaves a claimed bulk row in its lane', () => {
    enqueue('flood', 'bulk', 'flood-0');
    new ReflectionQueueClaimant().claimNext(store.db);

    expect(promoteJobs(store.db, {})).toBe(0);
  });
});
