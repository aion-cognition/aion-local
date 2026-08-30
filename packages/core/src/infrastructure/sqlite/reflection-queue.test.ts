import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { enqueueReflectionJob, getReflectionJob, listReflectionJobs } from './reflection-queue.js';

describe('reflection queue accessors', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-reflection-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues a job with a fresh id and default queue state', () => {
    const id = enqueueReflectionJob(store.db, 'integrate', { episodeId: 'ep-1' });
    const job = getReflectionJob(store.db, id);

    expect(job?.id).toBe(id);
    expect(job?.jobType).toBe('integrate');
    expect(job?.payload).toEqual({ episodeId: 'ep-1' });
    expect(job?.attempts).toBe(0);
    expect(job?.claimedAt).toBeNull();
    expect(job?.claimedBy).toBeNull();
    expect(job?.lastError).toBeNull();
    expect(job?.lane).toBe('interactive');
    expect(job?.sessionId).toBeNull();
  });

  it('records the lane and session a job was enqueued for', () => {
    const id = enqueueReflectionJob(
      store.db,
      'integrate',
      { episodeId: 'ep-1' },
      {
        lane: 'bulk',
        sessionId: 'session-a',
      },
    );

    expect(getReflectionJob(store.db, id)).toMatchObject({ lane: 'bulk', sessionId: 'session-a' });
  });

  it('returns undefined for an unknown id', () => {
    expect(getReflectionJob(store.db, 'does-not-exist')).toBeUndefined();
  });

  it('lists jobs in enqueue order', () => {
    const first = enqueueReflectionJob(store.db, 'integrate', { n: 1 });
    const second = enqueueReflectionJob(store.db, 'integrate', { n: 2 });

    const jobs = listReflectionJobs(store.db);
    expect(jobs.map((j) => j.id)).toEqual([first, second]);
  });
});
