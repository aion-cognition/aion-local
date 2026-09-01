import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { reconcileReenqueueOperation } from './reconcile-reenqueue.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { forgetNode, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { currentEpisodeIds } from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  enqueueReflectionJob,
  listReflectionJobs,
} from '../../../infrastructure/sqlite/reflection-queue.js';
import { INTEGRATE_JOB_TYPE } from '../../../reflection/application/intake.js';
import { orchestratorLedgerKey } from '../../../reflection/application/orchestrator.js';
import { PIPELINE_VERSION } from '../../../reflection/domain/version.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = {
  ...DEFAULTS,
  maintenance: { ...DEFAULTS.maintenance, reconcileBatchSize: 200 },
};

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-reconcile-reenqueue-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM reflection_queue');
  db.exec("DELETE FROM ops_ledger WHERE key LIKE 'reflection:orchestrator:%'");
});

function ctxFor(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * The two ordering tests below assert on tx_from order, so they start with nothing else in
 * scope. Forgotten rather than deleted, which is the substrate's own way of taking something
 * out of scope, and what `listStoredEpisodes` already filters on.
 */
async function forgetExistingEpisodes(): Promise<void> {
  for (const id of await currentEpisodeIds(harness.driver)) {
    await forgetNode(harness.driver, { id, now: NOW });
  }
}

function jobsFor(episodeId: string) {
  return listReflectionJobs(db).filter(
    (job) => (job.payload as { episode_id?: unknown } | null | undefined)?.episode_id === episodeId,
  );
}

describe('reconcile_reenqueue', () => {
  it('re-enqueues only the episodes with no ledger key and no queue row', async () => {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'reconcile-orphan',
      properties: { text: 'orphaned episode' },
      now: NOW,
    });
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'reconcile-enriched',
      properties: { text: 'already enriched' },
      now: NOW,
    });
    markLedgerApplied(db, orchestratorLedgerKey(PIPELINE_VERSION, 'reconcile-enriched'), {
      done: true,
    });

    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'reconcile-already-queued',
      properties: { text: 'waiting in the queue already' },
      now: NOW,
    });
    enqueueReflectionJob(db, INTEGRATE_JOB_TYPE, { episode_id: 'reconcile-already-queued' });

    const operation = reconcileReenqueueOperation();
    const first = await operation.run(ctxFor());

    expect(first.status).toBe('applied');
    expect(first.itemsAffected).toBe(1);
    expect(jobsFor('reconcile-orphan')).toHaveLength(1);
    expect(jobsFor('reconcile-orphan')[0]?.lane).toBe('bulk');
    expect(jobsFor('reconcile-enriched')).toHaveLength(0);
    expect(jobsFor('reconcile-already-queued')).toHaveLength(1);

    // The orphan now has a queue row of its own: a second pass finds nothing left to fix.
    const second = await operation.run(ctxFor());
    expect(second.status).toBe('noop');
    expect(second.itemsAffected).toBe(0);
    expect(jobsFor('reconcile-orphan')).toHaveLength(1);
  }, 60_000);

  it('bounds the jobs it writes without narrowing what it scanned, oldest first', async () => {
    await forgetExistingEpisodes();
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'reconcile-bound-old',
      properties: { text: 'older orphan' },
      now: new Date('2026-08-29T14:05:00.000Z'),
    });
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'reconcile-bound-new',
      properties: { text: 'newer orphan' },
      now: new Date('2026-08-29T14:10:00.000Z'),
    });

    const boundedConfig: Config = {
      ...config,
      maintenance: { ...config.maintenance, reconcileBatchSize: 1 },
    };
    const operation = reconcileReenqueueOperation();
    const result = await operation.run(ctxFor({ config: boundedConfig }));

    // Everything the substrate holds was looked at, and one job was written: the batch is a
    // bound on the write, not a window on the scan.
    expect(result.itemsProcessed).toBe(2);
    expect(result.itemsAffected).toBe(1);
    // The oldest waiting episode takes the one slot. Under a scan narrowed to the batch it
    // would sit outside the window forever while the count it is scored on kept reporting it.
    expect(jobsFor('reconcile-bound-old')).toHaveLength(1);
    expect(jobsFor('reconcile-bound-new')).toHaveLength(0);
  }, 60_000);

  it('reaches an episode far older than one batch of newer ones', async () => {
    await forgetExistingEpisodes();
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'reconcile-stranded',
      properties: { text: 'stranded months ago' },
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    for (let index = 0; index < 5; index += 1) {
      await writeStampedNode(harness.driver, {
        label: 'Episode',
        id: `reconcile-newer-${String(index)}`,
        properties: { text: 'stored since' },
        now: new Date(`2026-08-29T15:0${String(index)}:00.000Z`),
      });
    }

    const boundedConfig: Config = {
      ...config,
      maintenance: { ...config.maintenance, reconcileBatchSize: 2 },
    };
    const result = await reconcileReenqueueOperation().run(ctxFor({ config: boundedConfig }));

    expect(result.itemsAffected).toBe(2);
    expect(jobsFor('reconcile-stranded')).toHaveLength(1);
  }, 60_000);
});
