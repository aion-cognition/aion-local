import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { deadLetterOperation } from './dead-letter.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  countDeadLetterAttention,
  deadLetterSeenKey,
  listRetriedExhaustedJobs,
} from '../../../infrastructure/sqlite/dead-letter-queue.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  enqueueReflectionJob,
  getReflectionJob,
} from '../../../infrastructure/sqlite/reflection-queue.js';
import { acceptReferenceBatch } from '../../../infrastructure/sqlite/source-identity.js';
import type { ReflectionIntakeDeps } from '../../../reflection/application/intake.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * `dead_letter` never touches the graph, only `reflection_queue`, `ops_ledger`, and the SQLite
 * records a retry's conditions are read from. A real driver would just sit unused, so this file
 * skips the Neo4j harness entirely: the stub below satisfies `OperationContext`'s type and
 * nothing in the operation calls it.
 */
const driver = {} as Driver;

const NOW = new Date('2026-08-29T14:00:00.000Z');
const MAX_ATTEMPTS = 3;

let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = {
  ...DEFAULTS,
  operational: { ...DEFAULTS.operational, workerMaxAttempts: MAX_ATTEMPTS },
  maintenance: { ...DEFAULTS.maintenance, deadLetterBatchSize: 2 },
};

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-dead-letter-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM reflection_queue');
  db.exec("DELETE FROM ops_ledger WHERE key LIKE 'intro:dead_letter:%'");
  vi.stubEnv('AION_BUILD_SHA', 'build-a');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function ctxFor(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    driver,
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

function exhaust(jobId: string): void {
  db.prepare('UPDATE reflection_queue SET attempts = ? WHERE id = ?').run(MAX_ATTEMPTS, jobId);
}

function enqueueFor(episodeId: string): string {
  return enqueueReflectionJob(
    db,
    'integrate',
    { episode_id: episodeId },
    { lane: 'interactive', episodeId },
  );
}

/** A row that had its first retry and exhausted again, the state every case below starts in. */
async function failedAfterFirstRetry(episodeId: string): Promise<string> {
  const jobId = enqueueFor(episodeId);
  exhaust(jobId);
  await deadLetterOperation().run(ctxFor());
  exhaust(jobId);
  return jobId;
}

function routed(provider: Provider['route']): Provider {
  return { ...refusingProvider, route: provider };
}

describe('dead_letter', () => {
  it('gives an exhausted row a first retry: bulk lane, attempts reset, conditions recorded', async () => {
    const jobId = enqueueFor('ep-1');
    exhaust(jobId);

    const result = await deadLetterOperation().run(ctxFor());

    expect(result.status).toBe('applied');
    expect(result.itemsAffected).toBe(1);
    const job = getReflectionJob(db, jobId);
    expect(job?.lane).toBe('bulk');
    expect(job?.attempts).toBe(0);
    expect(job?.claimedAt).toBeNull();
    exhaust(jobId);
    const [retried] = listRetriedExhaustedJobs(db, MAX_ATTEMPTS);
    expect(retried?.retries).toEqual([
      {
        at: NOW.toISOString(),
        conditions: {
          build: 'build-a',
          readinessPolicy: 0,
          generationRoute: 'unrouted',
          processingGeneration: 0,
          referenceVersion: 0,
        },
      },
    ]);
  });

  it('holds a row that fails again under unchanged conditions, run after run, and keeps it counted', async () => {
    const jobId = await failedAfterFirstRetry('ep-2');

    const passes = [
      await deadLetterOperation().run(ctxFor()),
      await deadLetterOperation().run(ctxFor()),
      await deadLetterOperation().run(ctxFor()),
    ];

    expect(passes.map((pass) => pass.status)).toEqual(['noop', 'noop', 'noop']);
    expect(passes[0]?.detail).toContain('1 exhausted again under conditions already tried');
    // Never dropped: the row is still there, exhausted, and visible in the health count.
    const job = getReflectionJob(db, jobId);
    expect(job?.attempts).toBe(MAX_ATTEMPTS);
    expect(countDeadLetterAttention(db, MAX_ATTEMPTS)).toBe(1);
    expect(listRetriedExhaustedJobs(db, MAX_ATTEMPTS)[0]?.retries).toHaveLength(1);
  });

  it('reconsiders a row that failed again once a new build runs, once per build', async () => {
    const jobId = await failedAfterFirstRetry('ep-3');
    vi.stubEnv('AION_BUILD_SHA', 'build-b');

    const reconsidered = await deadLetterOperation().run(ctxFor());

    expect(reconsidered.status).toBe('applied');
    expect(reconsidered.detail).toContain('1 reconsidered under changed conditions');
    expect(getReflectionJob(db, jobId)?.attempts).toBe(0);

    // The fix did not take: the row fails again under build-b and is held there.
    exhaust(jobId);
    expect((await deadLetterOperation().run(ctxFor())).status).toBe('noop');
    // A rollback to a build it already failed under is not a new reason to try.
    vi.stubEnv('AION_BUILD_SHA', 'build-a');
    expect((await deadLetterOperation().run(ctxFor())).status).toBe('noop');
    const builds = listRetriedExhaustedJobs(db, MAX_ATTEMPTS)[0]?.retries.map(
      (retry) => retry.conditions?.build,
    );
    expect(builds).toEqual(['build-a', 'build-b']);
  });

  it("reconsiders a row once its source's evidence changes", async () => {
    const jobId = await failedAfterFirstRetry('ep-4');
    acceptReferenceBatch(db, {
      sourceId: 'ep-4',
      acceptedHash: 'refs-after-the-failure',
      receivedAt: NOW,
      operationKey: 'late-references',
      introduced: ['ref-1'],
    });

    const result = await deadLetterOperation().run(ctxFor());

    expect(result.itemsAffected).toBe(1);
    expect(getReflectionJob(db, jobId)?.lane).toBe('bulk');
    expect(getReflectionJob(db, jobId)?.attempts).toBe(0);
  });

  it('reconsiders a row once the generation route changes', async () => {
    const jobId = enqueueFor('ep-5');
    exhaust(jobId);
    const haiku = routed({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    await deadLetterOperation().run(ctxFor({ provider: haiku }));
    exhaust(jobId);
    expect((await deadLetterOperation().run(ctxFor({ provider: haiku }))).status).toBe('noop');

    const luna = routed({ provider: 'openai', model: 'gpt-6-luna' });
    const result = await deadLetterOperation().run(ctxFor({ provider: luna }));

    expect(result.itemsAffected).toBe(1);
    expect(getReflectionJob(db, jobId)?.attempts).toBe(0);
  });

  it('gives a row retried before conditions were recorded one recorded cycle, then holds it', async () => {
    const jobId = enqueueFor('ep-6');
    exhaust(jobId);
    markLedgerApplied(db, deadLetterSeenKey(jobId), { jobType: 'integrate' });

    const first = await deadLetterOperation().run(ctxFor());
    exhaust(jobId);
    const second = await deadLetterOperation().run(ctxFor());

    expect(first.itemsAffected).toBe(1);
    expect(second.status).toBe('noop');
    const retries = listRetriedExhaustedJobs(db, MAX_ATTEMPTS)[0]?.retries ?? [];
    expect(retries).toHaveLength(2);
    expect(retries[0]?.conditions).toBeUndefined();
    expect(retries[1]?.conditions?.build).toBe('build-a');
  });

  it('wakes the worker for every row it re-lanes', async () => {
    const woken: string[] = [];
    const intake = {
      onJobEnqueued: (jobId: string): void => {
        woken.push(jobId);
      },
    } as ReflectionIntakeDeps;
    const jobId = enqueueFor('ep-7');
    exhaust(jobId);

    await deadLetterOperation().run(ctxFor({ intake }));

    expect(woken).toEqual([jobId]);
  });

  it('bounds one run to deadLetterBatchSize rows, first retries and reconsiderations together', async () => {
    const waiting = await failedAfterFirstRetry('ep-8');
    const ids = [enqueueFor('ep-9'), enqueueFor('ep-10')];
    ids.forEach(exhaust);
    vi.stubEnv('AION_BUILD_SHA', 'build-b');

    const result = await deadLetterOperation().run(ctxFor());

    expect(result.itemsAffected).toBe(2);
    expect(result.detail).toContain('(1 more next run)');
    expect(getReflectionJob(db, waiting)?.attempts).toBe(MAX_ATTEMPTS);
    expect(ids.map((id) => getReflectionJob(db, id)?.lane)).toEqual(['bulk', 'bulk']);

    const next = await deadLetterOperation().run(ctxFor());
    expect(next.itemsAffected).toBe(1);
    expect(getReflectionJob(db, waiting)?.attempts).toBe(0);
  });
});
