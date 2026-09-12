import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import { GraphTransaction } from './connection.js';
import { runGraphMigrations } from './migrations.js';
import { lockPublicationGuard } from './publication-receipt.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PublicationUnavailable, PublicationPendingError } from '../publication/errors.js';
import { PublicationOperation } from '../publication/operation.js';
import { buildEvidenceRevision } from '../publication/preconditions.js';
import { readCurrentCoverageContract } from '../sqlite/coverage-contract.js';
import { SqliteStore } from '../sqlite/database.js';
import { coordinatorControl } from '../sqlite/publication-coordinator-store.js';

const logger = { warn: () => undefined, error: () => undefined };
let dir: string;
let substrate: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let resultSize = 1;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-publication-errors-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  const handler = new PublicationOperation({
    kind: 'semantic_write',
    effectKinds: [],
    payload: z.strictObject({}),
    data: z.strictObject({}),
    result: z.strictObject({ blob: z.string() }),
    prepare(context) {
      const coverage = readCurrentCoverageContract(context.db);
      if (coverage === undefined) {
        throw new Error('fixture coverage is absent');
      }
      return Promise.resolve({
        data: {},
        scopes: [],
        effects: [],
        expected: {
          coverageEpoch: coverage.epoch,
          evidence: buildEvidenceRevision([]),
          sources: [],
          heads: [],
        },
      });
    },
    check: () => Promise.resolve({ status: 'valid' as const }),
    applyGraph: () => Promise.resolve({ blob: 'x'.repeat(resultSize) }),
    prepareSqlite: () => undefined,
    acknowledgeSqlite: () => undefined,
    discardSqlite: () => undefined,
  });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    handlers: [handler],
    logger,
    intentByteLimit: 1024,
    transactionTimeoutMs: 300,
  });
  await coordinator.initialize();
}, 300_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('preserves an oversized result as an unavailable byte limit through publish and recovery', async () => {
  resultSize = 4096;
  try {
    for (const attempt of [
      () => coordinator.publish({ kind: 'semantic_write', operationId: 'oversized', payload: {} }),
      () => coordinator.recover(),
    ]) {
      const failure: unknown = await attempt().catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(PublicationUnavailable);
      expect(failure).not.toBeInstanceOf(PublicationPendingError);
      expect(failure).toMatchObject({ reason: 'publication_byte_limit' });
    }
    expect(coordinator.hasPending()).toBe(true);
  } finally {
    resultSize = 1;
    await coordinator.recover();
  }
});

it('classifies a SQLite writer conflict without waiting or allocating an intent', async () => {
  const other = new Database(substrate.sqlitePath);
  other.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  try {
    const failure: unknown = await coordinator
      .publish({ kind: 'semantic_write', operationId: 'busy', payload: {} })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PublicationUnavailable);
    expect(failure).toMatchObject({
      reason: 'store_busy',
      retryable: true,
      cause: { code: 'SQLITE_BUSY' },
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(coordinator.hasPending()).toBe(false);
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
});

it('classifies a native guard timeout before an intent exists as retryable', async () => {
  const session = substrate.harness.driver.session();
  const native = await session.beginTransaction({ timeout: 20_000 });
  try {
    await lockPublicationGuard(
      new GraphTransaction(native),
      coordinatorControl(store.db).substrateId,
      new Date(),
    );
    const started = performance.now();
    const failure: unknown = await coordinator
      .publish({ kind: 'semantic_write', operationId: 'timeout', payload: {} })
      .catch((err: unknown) => err);
    console.log('PUBLICATION_GUARD_TIMEOUT', { elapsedMs: performance.now() - started, failure });
    expect(failure).toBeInstanceOf(PublicationUnavailable);
    expect(failure).not.toBeInstanceOf(PublicationPendingError);
    expect(failure).toMatchObject({ reason: 'store_unavailable', retryable: true });
    expect(coordinator.hasPending()).toBe(false);
  } finally {
    await native.rollback();
    await session.close();
  }
}, 25_000);

it('degrades completion under a guard timeout without running its effects', async () => {
  const checkpoint = await coordinator.checkpoint();
  if (checkpoint.status !== 'ready') {
    throw new Error('fixture checkpoint unavailable');
  }
  const session = substrate.harness.driver.session();
  const native = await session.beginTransaction({ timeout: 20_000 });
  let validated = false;
  let completed = false;
  try {
    await lockPublicationGuard(
      new GraphTransaction(native),
      coordinatorControl(store.db).substrateId,
      new Date(),
    );
    expect(
      await coordinator.completeRead(
        checkpoint.checkpoint,
        () => {
          validated = true;
          return Promise.resolve(true);
        },
        () => {
          completed = true;
          return 1;
        },
      ),
    ).toEqual({ status: 'retry', reason: 'store_unavailable' });
    expect(validated).toBe(false);
    expect(completed).toBe(false);
  } finally {
    await native.rollback();
    await session.close();
  }
}, 25_000);

it('degrades a completion SQLite conflict without committing an effect', async () => {
  const checkpoint = await coordinator.checkpoint();
  if (checkpoint.status !== 'ready') {
    throw new Error('fixture checkpoint unavailable');
  }
  const other = new Database(substrate.sqlitePath);
  other.exec('BEGIN IMMEDIATE');
  let completed = false;
  try {
    expect(
      await coordinator.completeRead(
        checkpoint.checkpoint,
        () => Promise.resolve(true),
        () => {
          completed = true;
          return 1;
        },
      ),
    ).toEqual({ status: 'retry', reason: 'store_busy' });
    expect(completed).toBe(false);
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
});
