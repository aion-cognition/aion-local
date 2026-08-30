import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deadLetterOperation } from './dead-letter.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { countDeadLetterAttention } from '../../../infrastructure/sqlite/dead-letter-queue.js';
import {
  enqueueReflectionJob,
  getReflectionJob,
} from '../../../infrastructure/sqlite/reflection-queue.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * `dead_letter` never touches the graph, only `reflection_queue` and `ops_ledger`. A real
 * driver would just sit unused, so this file skips the Neo4j harness entirely: the stub
 * below satisfies `OperationContext`'s type and nothing in the operation calls it.
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

describe('dead_letter', () => {
  it('gives an exhausted row one retry: bulk lane, attempts reset', async () => {
    const jobId = enqueueReflectionJob(
      db,
      'integrate',
      { episode_id: 'ep-1' },
      { lane: 'interactive' },
    );
    exhaust(jobId);

    const operation = deadLetterOperation();
    const result = await operation.run(ctxFor());

    expect(result.status).toBe('applied');
    expect(result.itemsAffected).toBe(1);
    const job = getReflectionJob(db, jobId);
    expect(job?.lane).toBe('bulk');
    expect(job?.attempts).toBe(0);
    expect(job?.claimedAt).toBeNull();
    expect(countDeadLetterAttention(db, MAX_ATTEMPTS)).toBe(0);
  });

  it('leaves a row alone once it exhausts a second time, and surfaces it instead', async () => {
    const jobId = enqueueReflectionJob(
      db,
      'integrate',
      { episode_id: 'ep-2' },
      { lane: 'interactive' },
    );
    exhaust(jobId);
    await deadLetterOperation().run(ctxFor());

    // The retry failed too: the row is exhausted again.
    exhaust(jobId);
    const second = await deadLetterOperation().run(ctxFor());

    expect(second.status).toBe('noop');
    expect(second.itemsAffected).toBe(0);
    expect(second.detail).toContain('1 already retried and still exhausted');
    // Never dropped: the row is still there, exhausted, waiting on a person.
    const job = getReflectionJob(db, jobId);
    expect(job?.attempts).toBe(MAX_ATTEMPTS);
    expect(countDeadLetterAttention(db, MAX_ATTEMPTS)).toBe(1);
  });

  it('bounds one run to deadLetterBatchSize rows', async () => {
    const ids = [
      enqueueReflectionJob(db, 'integrate', { episode_id: 'ep-3' }),
      enqueueReflectionJob(db, 'integrate', { episode_id: 'ep-4' }),
      enqueueReflectionJob(db, 'integrate', { episode_id: 'ep-5' }),
    ];
    ids.forEach(exhaust);

    const result = await deadLetterOperation().run(ctxFor());

    expect(result.itemsProcessed).toBe(2);
    expect(result.itemsAffected).toBe(2);
    const relaned = ids.filter((id) => getReflectionJob(db, id)?.lane === 'bulk');
    expect(relaned).toHaveLength(2);
  });
});
