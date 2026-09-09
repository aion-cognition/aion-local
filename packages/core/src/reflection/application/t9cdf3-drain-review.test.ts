import type { Driver } from 'neo4j-driver';
import { expect, it, vi } from 'vitest';

import { SourceIndexDrainer } from './index-drain.js';
import { SOURCE_INDEX_JOB_TYPE } from './intake-queue.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  enqueueReflectionJob,
  listReflectionJobs,
} from '../../infrastructure/sqlite/reflection-queue.js';
import * as indexing from '../../introspection/application/source-index.js';

it('keeps a later row scheduled when an earlier retry timer fires and succeeds', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const store = new SqliteStore({ filePath: ':memory:' });
  const logger = { warn: () => undefined, debug: () => undefined };
  const drainer = new SourceIndexDrainer(
    {
      db: store.db,
      resolver: new EvidenceResolver({ driver: {} as Driver, db: store.db, logger }),
      logger,
      now: () => new Date(),
    },
    { maxJobs: 2, retryBaseMs: 10000, retryCapMs: 100000 },
  );
  const visits: string[] = [];
  vi.spyOn(indexing, 'runSourceIndexJob').mockImplementation(async (_deps, request) => {
    const seen = visits.includes(request.sourceId);
    visits.push(request.sourceId);
    return seen
      ? {
          status: 'indexed',
          documents: 1,
          replaced: 0,
          truncated: 0,
          indexedBytes: 1,
          complete: true,
        }
      : { status: 'search_unavailable', cause: 'search_store_error', detail: 'transient' };
  });
  try {
    enqueueReflectionJob(
      store.db,
      SOURCE_INDEX_JOB_TYPE,
      { episode_id: 'early' },
      { episodeId: 'early', lane: 'bulk', now: new Date() },
    );
    drainer.pump();
    await Promise.allSettled(drainer.inFlight());
    await vi.advanceTimersByTimeAsync(5000);
    enqueueReflectionJob(
      store.db,
      SOURCE_INDEX_JOB_TYPE,
      { episode_id: 'late' },
      { episodeId: 'late', lane: 'bulk', now: new Date() },
    );
    drainer.pump();
    await Promise.allSettled(drainer.inFlight());
    expect(visits).toEqual(['early', 'late']);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.allSettled(drainer.inFlight());
    expect(visits).toEqual(['early', 'late', 'early']);
    expect(listReflectionJobs(store.db).map((x) => x.episodeId)).toEqual(['late']);
    await vi.advanceTimersByTimeAsync(20000);
    await Promise.allSettled(drainer.inFlight());
    expect.soft(visits.filter((x) => x === 'late')).toHaveLength(2);
    expect(listReflectionJobs(store.db)).toEqual([]);
  } finally {
    drainer.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    store.close();
  }
});
