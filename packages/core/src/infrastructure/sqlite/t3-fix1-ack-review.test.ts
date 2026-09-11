import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { activateCoverageContract, readCurrentCoverageContract } from './coverage-contract.js';
import { SqliteStore } from './database.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  listOutstandingWork,
  prepareInventorySkeleton,
  readGeneration,
} from './processing-generations.js';

const NOW = new Date('2026-09-08T02:00:00Z');
const LATER = new Date('2026-09-08T03:00:00Z');
let dir: string;
let store: SqliteStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-ack-review-'));
  store = new SqliteStore({ filePath: join(dir, 'store.sqlite') });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('keeps an inactive inventory out of a one-row page before the active inventory', () => {
  for (const sourceId of ['a-prepared', 'z-active']) {
    const generation = allocateProcessingGeneration(store.db, {
      sourceId,
      policyRevision: 1,
      createdAt: NOW,
    });
    prepareInventorySkeleton(store.db, {
      sourceId,
      processingGeneration: generation,
      stageNames: ['entities'],
      dueAt: NOW,
    });
    if (sourceId === 'z-active') {
      activateProcessingGeneration(store.db, sourceId, generation);
    }
  }
  expect(listOutstandingWork(store.db, LATER, 1).map((row) => row.sourceId)).toEqual(['z-active']);
});

it('rolls back generation publication and its readiness counter with the enclosing acknowledgment', () => {
  const first = allocateProcessingGeneration(store.db, {
    sourceId: 'source',
    policyRevision: 1,
    createdAt: NOW,
  });
  activateProcessingGeneration(store.db, 'source', first);
  const second = allocateProcessingGeneration(store.db, {
    sourceId: 'source',
    policyRevision: 2,
    createdAt: LATER,
  });
  prepareInventorySkeleton(store.db, {
    sourceId: 'source',
    processingGeneration: second,
    stageNames: ['entities'],
    dueAt: NOW,
  });
  expect(() =>
    store.db
      .transaction(() => {
        activateProcessingGeneration(store.db, 'source', second);
        throw new Error('ack failed');
      })
      .immediate(),
  ).toThrow('ack failed');
  expect(readGeneration(store.db, 'source', first)).toMatchObject({
    state: 'active',
    operationalRevision: 1,
  });
  expect(readGeneration(store.db, 'source', second)).toMatchObject({
    state: 'allocated',
    operationalRevision: 0,
  });
  expect(listOutstandingWork(store.db, LATER, 1)).toEqual([]);
});

it('returns an old activation receipt after reopen without replacing the newer current policy', () => {
  const original = { operationId: 'first', activatedAt: NOW, fieldPolicyVersion: 1 };
  const first = activateCoverageContract(store.db, original);
  const newer = activateCoverageContract(store.db, {
    operationId: 'second',
    activatedAt: LATER,
    fieldPolicyVersion: 2,
  });
  store.close();
  store = new SqliteStore({ filePath: join(dir, 'store.sqlite') });
  expect(activateCoverageContract(store.db, original)).toEqual(first);
  expect(readCurrentCoverageContract(store.db)).toEqual(newer);
  expect(store.db.prepare('SELECT count(*) AS n FROM coverage_contract').get()).toEqual({ n: 2 });
});

it('rolls back the coverage receipt together with its registry row', () => {
  const activation = { operationId: 'activation', activatedAt: NOW, fieldPolicyVersion: 1 };
  expect(() =>
    store.db
      .transaction(() => {
        activateCoverageContract(store.db, activation);
        throw new Error('ack failed');
      })
      .immediate(),
  ).toThrow('ack failed');
  expect(readCurrentCoverageContract(store.db)).toBeUndefined();
  expect(
    store.db
      .prepare("SELECT count(*) AS n FROM ops_ledger WHERE key LIKE 'coverage-activation:%'")
      .get(),
  ).toEqual({ n: 0 });
  const completed = activateCoverageContract(store.db, activation);
  expect(activateCoverageContract(store.db, activation)).toEqual(completed);
  expect(store.db.prepare('SELECT count(*) AS n FROM coverage_contract').get()).toEqual({ n: 1 });
});
