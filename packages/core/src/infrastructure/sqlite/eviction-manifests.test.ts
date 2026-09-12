import { afterEach, beforeEach, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  ageObsoleteSurvivorWork,
  discardSurvivorWork,
  prepareSurvivorWork,
  survivorWorkOf,
  SURVIVOR_DISCARDED_REASON,
  SURVIVOR_LAPSED_REASON,
} from './eviction-manifests.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
} from './processing-generations.js';

/**
 * The end of a parked survivor obligation's life.
 *
 * A discarded attempt leaves a row that a later attempt may still adopt, and the rule for that is
 * narrow: same source, same generation, same node. The sweep exists for what happens when the
 * generation moves past it, which is the one case where the row stops being a waiting obligation
 * and starts being a record of one, with nothing in the tree able to tell the two apart.
 */

const NOW = new Date('2026-09-12T09:00:00.000Z');
const SOURCE = 'source-a';

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

/** Allocates a generation and makes it the live one, which is what a source is processed under. */
function generation(sourceId = SOURCE): number {
  const allocated = allocateProcessingGeneration(store.db, {
    sourceId,
    policyRevision: 1,
    createdAt: NOW,
  });
  activateProcessingGeneration(store.db, sourceId, allocated);
  return allocated;
}

/** One prepared-then-discarded obligation, which is the state the sweep is about. */
function parked(operationId: string, processingGeneration: number, nodeId = 'node-1'): void {
  prepareSurvivorWork(store.db, {
    operationId,
    sourceId: SOURCE,
    processingGeneration,
    obligations: [{ nodeId, neighborhoodRevision: 'rev-1' }],
  });
  discardSurvivorWork(store.db, operationId);
}

function reasonOf(operationId: string): string | undefined {
  const row = store.db
    .prepare('SELECT reason FROM source_work WHERE publication_operation_id = ?')
    .get(operationId) as { reason: string | null } | undefined;
  return row?.reason ?? undefined;
}

it('leaves a parked obligation alone while its generation is still the live one', () => {
  const live = generation();
  parked('op-1', live);

  expect(ageObsoleteSurvivorWork(store.db, 8)).toBe(0);
  expect(reasonOf('op-1')).toBe(SURVIVOR_DISCARDED_REASON);
});

it('ages a parked obligation once its generation has been replaced', () => {
  const first = generation();
  parked('op-1', first);
  generation();

  expect(ageObsoleteSurvivorWork(store.db, 8)).toBe(1);
  expect(reasonOf('op-1')).toBe(SURVIVOR_LAPSED_REASON);
});

it('keeps the aged row and its provenance rather than deleting either', () => {
  const first = generation();
  parked('op-1', first);
  generation();
  ageObsoleteSurvivorWork(store.db, 8);

  const [task] = survivorWorkOf(store.db, 'op-1');
  expect(task?.state).toBe('obsolete');
  expect(task?.nodeId).toBe('node-1');
  expect(task?.neighborhoodRevision).toBe('rev-1');
});

it('does not age the same row twice', () => {
  const first = generation();
  parked('op-1', first);
  generation();

  expect(ageObsoleteSurvivorWork(store.db, 8)).toBe(1);
  expect(ageObsoleteSurvivorWork(store.db, 8)).toBe(0);
});

it('drains across ticks instead of taking the whole backlog at once', () => {
  const first = generation();
  parked('op-1', first, 'node-1');
  parked('op-2', first, 'node-2');
  parked('op-3', first, 'node-3');
  generation();

  expect(ageObsoleteSurvivorWork(store.db, 2)).toBe(2);
  expect(ageObsoleteSurvivorWork(store.db, 2)).toBe(1);
  expect(ageObsoleteSurvivorWork(store.db, 2)).toBe(0);
});

it('asks for nothing when the batch is empty', () => {
  const first = generation();
  parked('op-1', first);
  generation();

  expect(ageObsoleteSurvivorWork(store.db, 0)).toBe(0);
  expect(reasonOf('op-1')).toBe(SURVIVOR_DISCARDED_REASON);
});

it('re-adoption still wins while the generation stands, and the sweep cannot race it', () => {
  const live = generation();
  parked('op-1', live);
  expect(ageObsoleteSurvivorWork(store.db, 8)).toBe(0);

  prepareSurvivorWork(store.db, {
    operationId: 'op-2',
    sourceId: SOURCE,
    processingGeneration: live,
    obligations: [{ nodeId: 'node-1', neighborhoodRevision: 'rev-2' }],
  });

  expect(survivorWorkOf(store.db, 'op-1')).toEqual([]);
  const [adopted] = survivorWorkOf(store.db, 'op-2');
  expect(adopted?.state).toBe('pinned');
});
