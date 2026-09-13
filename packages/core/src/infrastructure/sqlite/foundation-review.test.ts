import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activateCoverageContract,
  prepareCoverageContract,
  readCurrentCoverageContract,
} from './coverage-contract.js';
import { SqliteStore } from './database.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  listOutstandingWork,
  listStageWork,
  prepareInventorySkeleton,
  readGeneration,
} from './processing-generations.js';
import { acceptReferenceBatch, listReferenceBatches } from './source-identity.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const LATER = new Date('2026-09-08T03:00:00.000Z');

describe('durable foundation boundaries', () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = new SqliteStore({ filePath: ':memory:' });
  });
  afterEach(() => {
    store.close();
  });

  it('persists the new occurrence inventory before activation without making it runnable', () => {
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: 'source',
      policyRevision: 1,
      createdAt: NOW,
    });
    prepareInventorySkeleton(store.db, {
      sourceId: 'source',
      processingGeneration: generation,
      stageNames: ['entities', 'cognitive'],
      dueAt: NOW,
    });
    expect(listStageWork(store.db, 'source', generation).map((work) => work.stageName)).toEqual([
      'cognitive',
      'entities',
    ]);
    expect(readGeneration(store.db, 'source', generation)?.state).toBe('allocated');
    expect(listOutstandingWork(store.db, LATER, 10)).toEqual([]);
    activateProcessingGeneration(store.db, 'source', generation);
    expect(listOutstandingWork(store.db, LATER, 10)).toHaveLength(2);
  });

  it('keeps allocated-generation rows out of runnable nomination', () => {
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: 'source',
      policyRevision: 1,
      createdAt: NOW,
    });
    // The durable prepare state after intake has written its required rows.
    store.db
      .prepare(
        `INSERT INTO source_work
       (work_id, source_id, processing_generation, kind, stage_name, work_key, state, due_at)
       VALUES ('prepared-stage', 'source', ?, 'stage', 'entities', 'stage:entities', 'pending', ?)`,
      )
      .run(generation, NOW.toISOString());
    expect(listOutstandingWork(store.db, LATER, 1)).toEqual([]);
  });

  it('keeps a no-change reference delivery idempotent after a later accepted set', () => {
    const base = { sourceId: 'source', receivedAt: NOW };
    acceptReferenceBatch(store.db, {
      ...base,
      operationKey: 'first',
      acceptedHash: 'a',
      introduced: ['ref-a'],
    });
    const noChange = {
      ...base,
      operationKey: 'duplicate',
      acceptedHash: 'a',
      introduced: [],
    };
    const original = acceptReferenceBatch(store.db, noChange);
    acceptReferenceBatch(store.db, {
      ...base,
      operationKey: 'later',
      acceptedHash: 'ab',
      introduced: ['ref-b'],
    });
    const before = listReferenceBatches(store.db, 'source');
    expect(acceptReferenceBatch(store.db, noChange)).toEqual(original);
    expect(listReferenceBatches(store.db, 'source')).toEqual(before);
  });

  it('preserves the original history horizon across a later policy epoch', () => {
    prepareCoverageContract(store.db, 1);
    const first = activateCoverageContract(store.db, {
      activatedAt: NOW,
      fieldPolicyVersion: 1,
    });
    const next = activateCoverageContract(store.db, {
      activatedAt: LATER,
      fieldPolicyVersion: 2,
    });
    expect(next.epoch).not.toBe(first.epoch);
    expect(next.historySince).toBe(first.historySince);
    expect(next.activatedAt).toBe(first.activatedAt);
  });

  it('cannot downgrade active coverage through repeated preparing initialization', () => {
    prepareCoverageContract(store.db, 1);
    const active = activateCoverageContract(store.db, {
      activatedAt: NOW,
      fieldPolicyVersion: 1,
    });
    try {
      prepareCoverageContract(store.db, 1);
    } catch {
      // A refusal is as safe as returning the active record unchanged.
    }
    expect(readCurrentCoverageContract(store.db)).toEqual(active);
  });
});
