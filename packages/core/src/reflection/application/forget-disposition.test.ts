import { afterEach, beforeEach, expect, it } from 'vitest';

import { reopenWorkAWithdrawnForgetClosed, WITHDRAWN_FORGET_REASON } from './forget-disposition.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  completeSourceWork,
  createSourceWork,
  readActiveGeneration,
  stageWorkId,
} from '../../infrastructure/sqlite/processing-generations.js';
import { readGenerationWork } from '../../infrastructure/sqlite/source-readiness.js';

/**
 * What a withdrawn forget owes again, re-owed by the writer that withdraws it.
 *
 * The settlement reverses its own disposition the next time a run passes over the source, which
 * is the right place for a run to find the work already owed and the wrong place for it to become
 * owed. Between the unforget and that run the rows read completed, nothing reports an obligation,
 * and an eviction is free to remove a source whose passes were never performed.
 */

const NOW = new Date('2026-09-12T12:00:00.000Z');
const SOURCE = 'episode-1';

let store: SqliteStore;

function generation(): number {
  const active = readActiveGeneration(store.db, SOURCE);
  if (active === undefined) {
    throw new Error('no active generation');
  }
  return active.processingGeneration;
}

/** One stage row, closed the way the disposition closes it: completed, with the forget's reason. */
function closedByForget(stageName: string): string {
  const workId = stageWorkId(SOURCE, generation(), stageName);
  createSourceWork(store.db, {
    workId,
    sourceId: SOURCE,
    processingGeneration: generation(),
    kind: 'stage',
    stageName,
    workKey: stageName,
    dueAt: NOW,
  });
  completeSourceWork(
    store.db,
    workId,
    { outcome: 'not_applicable', reason: 'source_forgotten' },
    NOW,
  );
  return workId;
}

function stateOf(workId: string): { state: string; reason: string | undefined } {
  const row = readGenerationWork(store.db, SOURCE, generation()).find(
    (entry) => entry.workId === workId,
  );
  if (row === undefined) {
    throw new Error(`no row for ${workId}`);
  }
  return { state: row.state, reason: row.outcome?.reason };
}

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  const allocated = allocateProcessingGeneration(store.db, {
    sourceId: SOURCE,
    policyRevision: 1,
    createdAt: NOW,
  });
  activateProcessingGeneration(store.db, SOURCE, allocated);
});

afterEach(() => {
  store.close();
});

it('re-owes every row the disposition closed, and says which statement stopped holding', () => {
  const entities = closedByForget('entities');
  const cognitive = closedByForget('cognitive');
  expect(stateOf(entities).state).toBe('completed');

  expect(reopenWorkAWithdrawnForgetClosed(store.db, SOURCE, NOW)).toBe(2);

  for (const workId of [entities, cognitive]) {
    expect(stateOf(workId)).toEqual({ state: 'pending', reason: undefined });
  }
  expect(WITHDRAWN_FORGET_REASON).toContain('withdrawn');
});

it('leaves alone a row that closed for its own reasons', () => {
  const workId = stageWorkId(SOURCE, generation(), 'entities');
  createSourceWork(store.db, {
    workId,
    sourceId: SOURCE,
    processingGeneration: generation(),
    kind: 'stage',
    stageName: 'entities',
    workKey: 'entities',
    dueAt: NOW,
  });
  completeSourceWork(store.db, workId, { outcome: 'complete', reason: 'the pass ran' }, NOW);

  // The reason is the whole test. A row that ran is not a row a forget closed, and re-owing it
  // would ask for work somebody already did.
  expect(reopenWorkAWithdrawnForgetClosed(store.db, SOURCE, NOW)).toBe(0);
  expect(stateOf(workId).state).toBe('completed');
});

it('answers zero for a source with no active generation', () => {
  expect(reopenWorkAWithdrawnForgetClosed(store.db, 'episode-nowhere', NOW)).toBe(0);
});
