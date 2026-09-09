import type { Driver } from 'neo4j-driver';
import { afterEach, expect, it, vi } from 'vitest';

import { SourceIndexDrainer } from './index-drain.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import * as queue from '../../introspection/application/source-index-queue.js';

afterEach(() => {
  vi.restoreAllMocks();
});
it('backs off a full deferred page instead of immediately reclaiming the same rows', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  const logger = { warn: () => undefined, debug: () => undefined };
  const drainer = new SourceIndexDrainer(
    {
      db: store.db,
      resolver: new EvidenceResolver({ db: store.db, driver: {} as Driver, logger }),
      logger,
      now: () => new Date(),
    },
    { maxJobs: 1, retryBaseMs: 60000 },
  );
  let calls = 0;
  vi.spyOn(queue, 'drainSourceIndexQueue').mockImplementation(async () => {
    calls += 1;
    if (calls === 3) {
      drainer.stop();
    }
    return { claimed: 1, completed: 0, documents: 0, deferred: 1 };
  });
  try {
    drainer.pump();
    await Promise.allSettled(drainer.inFlight());
    expect(calls).toBe(1);
  } finally {
    drainer.stop();
    store.close();
  }
});
