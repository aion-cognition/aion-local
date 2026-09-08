import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  backfillReflectionQueueEpisodeIds,
  enqueueReflectionJob,
  findPendingJobForEpisode,
  getReflectionJob,
  legacyEpisodeQueueRows,
  listReflectionJobs,
} from './reflection-queue.js';

/** A row as it was written before the column existed: payload only, column null. */
function enqueueLegacyRow(db: SqliteStore['db'], jobType: string, episodeId: string): string {
  const id = enqueueReflectionJob(db, jobType, { episode_id: episodeId }, { episodeId });
  db.prepare('UPDATE reflection_queue SET episode_id = NULL WHERE id = ?').run(id);
  return id;
}

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

describe('queue episode column transition', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-queue-episode-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores the episode beside the payload and finds the pending job by it', () => {
    const id = enqueueReflectionJob(
      store.db,
      'integrate',
      { episode_id: 'ep-1' },
      { episodeId: 'ep-1' },
    );

    expect(legacyEpisodeQueueRows(store.db)).toBe(0);
    expect(findPendingJobForEpisode(store.db, 'integrate', 'ep-1')?.id).toBe(id);
    expect(findPendingJobForEpisode(store.db, 'integrate', 'ep-2')).toBeUndefined();
  });

  it('reuses an active legacy row rather than queueing a second job for it', () => {
    const legacy = enqueueLegacyRow(store.db, 'integrate', 'ep-legacy');

    expect(legacyEpisodeQueueRows(store.db)).toBe(1);
    expect(findPendingJobForEpisode(store.db, 'integrate', 'ep-legacy')?.id).toBe(legacy);
  });

  it('backfills active rows and then answers from the column alone', () => {
    const legacy = enqueueLegacyRow(store.db, 'integrate', 'ep-legacy');

    expect(backfillReflectionQueueEpisodeIds(store.db)).toBe(1);
    expect(backfillReflectionQueueEpisodeIds(store.db)).toBe(0);
    expect(legacyEpisodeQueueRows(store.db)).toBe(0);
    expect(findPendingJobForEpisode(store.db, 'integrate', 'ep-legacy')?.id).toBe(legacy);
  });

  it('leaves a row whose payload names no episode out of the backfill', () => {
    enqueueReflectionJob(store.db, 'reinforce', { other: 'thing' });

    expect(backfillReflectionQueueEpisodeIds(store.db)).toBe(0);
    expect(legacyEpisodeQueueRows(store.db)).toBe(1);
  });

  it('backfills what a substrate already holds when the store is reopened', () => {
    enqueueLegacyRow(store.db, 'integrate', 'ep-legacy');
    store.close();
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });

    expect(legacyEpisodeQueueRows(store.db)).toBe(0);
    expect(findPendingJobForEpisode(store.db, 'integrate', 'ep-legacy')).toBeDefined();
  });
});
