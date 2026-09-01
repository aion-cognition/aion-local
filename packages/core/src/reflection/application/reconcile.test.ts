import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATE_JOB_TYPE } from './intake.js';
import { orchestratorLedgerKey } from './orchestrator.js';
import { reconcileEnrichment } from './reconcile.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { enqueueReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * The ledger side of the reconcile join, against a stored-episode list the test supplies. The
 * graph side is proven against a real server in `reconcile-reenqueue.int.test.ts`; what matters
 * here is that the episode id still falls out of a key that now carries a version.
 */

/** Answers the one read `reconcileEnrichment` makes, and nothing else. */
function episodeGraph(ids: readonly string[]): Driver {
  return {
    executeQuery: async (): Promise<unknown> => ({
      records: ids.map((id) => ({ toObject: () => ({ id, session_id: `session-${id}` }) })),
    }),
  } as unknown as Driver;
}

let store: SqliteStore;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-reconcile-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reconcileEnrichment', () => {
  it('recovers the episode id from a versioned orchestrator key', async () => {
    markLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, 'episode-1'), {
      stages: [],
    });

    const report = await reconcileEnrichment(episodeGraph(['episode-1', 'episode-2']), store.db);

    expect(report.enriched).toBe(1);
    expect(report.unenriched).toBe(1);
  });

  it('re-enqueues only the episode no versioned key and no queue row accounts for', async () => {
    markLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, 'enriched'));
    enqueueReflectionJob(store.db, INTEGRATE_JOB_TYPE, { episode_id: 'queued' });

    const report = await reconcileEnrichment(
      episodeGraph(['enriched', 'queued', 'orphaned']),
      store.db,
      { reEnqueue: true },
    );

    expect(report).toMatchObject({
      episodes: 3,
      enriched: 1,
      queued: 1,
      unenriched: 1,
      reEnqueued: 1,
    });
  });

  it('counts an episode enriched under an earlier version as unenriched', async () => {
    markLedgerApplied(store.db, orchestratorLedgerKey('v0', 'episode-1'));

    const report = await reconcileEnrichment(episodeGraph(['episode-1']), store.db);

    expect(report.enriched).toBe(0);
    expect(report.unenriched).toBe(1);
  });

  it('does not read another episode id out of a key that only shares the prefix', async () => {
    markLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, 'episode-1'));

    const report = await reconcileEnrichment(episodeGraph(['episode-1:extra']), store.db);

    expect(report.enriched).toBe(0);
  });
});
