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

it('does not retry a deferred row immediately just because another row completed', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  const now = new Date('2026-01-01T00:00:00.000Z');
  const logger = { warn: () => undefined, debug: () => undefined };
  const drainer = new SourceIndexDrainer(
    {
      db: store.db,
      resolver: new EvidenceResolver({ driver: {} as Driver, db: store.db, logger }),
      logger,
      now: () => now,
    },
    { maxJobs: 2, retryBaseMs: 60000 },
  );
  enqueueReflectionJob(
    store.db,
    SOURCE_INDEX_JOB_TYPE,
    { episode_id: 'deferred' },
    { episodeId: 'deferred', lane: 'bulk', now },
  );
  enqueueReflectionJob(
    store.db,
    SOURCE_INDEX_JOB_TYPE,
    { episode_id: 'success' },
    { episodeId: 'success', lane: 'bulk', now },
  );
  const visits: string[] = [];
  vi.spyOn(indexing, 'runSourceIndexJob').mockImplementation(async (_deps, request) => {
    visits.push(request.sourceId);
    return request.sourceId === 'deferred'
      ? {
          status: 'search_unavailable',
          cause: 'search_store_error',
          detail: 'temporary read outage',
        }
      : {
          status: 'indexed',
          documents: 1,
          replaced: 0,
          truncated: 0,
          indexedBytes: 1,
          complete: true,
        };
  });
  try {
    drainer.pump();
    await Promise.allSettled(drainer.inFlight());
    expect(listReflectionJobs(store.db).map((row) => row.episodeId)).toEqual(['deferred']);
    expect(visits.filter((id) => id === 'success')).toHaveLength(1);
    expect(visits.filter((id) => id === 'deferred')).toHaveLength(1);
  } finally {
    drainer.stop();
    vi.restoreAllMocks();
    store.close();
  }
});
