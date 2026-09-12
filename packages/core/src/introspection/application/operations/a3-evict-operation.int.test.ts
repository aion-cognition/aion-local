import { beforeAll, expect, it } from 'vitest';

import { episodeEvictOperation } from './episode-evict.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import {
  nodeExists,
  seedUnknownEdge,
  seedVectoredEntity,
} from '../../../infrastructure/graph/test-support/a3-eviction-graph.fixture.js';
import { listRunnableSurvivorWork } from '../../../infrastructure/sqlite/eviction-manifests.js';
import { readSourceResidency } from '../../../infrastructure/sqlite/source-lifecycle.js';
import {
  activateCoverage,
  armEviction,
  chunks,
  driver,
  eligibleSource,
  NOW,
  publications,
  sessionOf,
  store,
} from '../../../reflection/application/test-support/a3-eviction.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { readEvictionDemand } from '../eviction-census.js';

/**
 * The catalog operation end to end: what the tick reads, what the score says, and what one
 * bounded invocation actually does.
 *
 * Demand is asked of the same durable fence the run publishes behind, so a reading that says one
 * eligible source is a reading a run can act on. What the operation adds is order and bounds:
 * recovery first, then the work a receipt already bought, then a bounded number of attempts.
 */

const SCALES = { batch: 8, minAgeMs: 0 };

function demand() {
  return readEvictionDemand(store.db, { now: NOW, minAgeMs: SCALES.minAgeMs });
}

function context(): OperationContext {
  return {
    driver,
    db: store.db,
    config: DEFAULTS,
    provider: chunks.provider,
    logger: chunks.logger,
    narratives: { publications, resolver: chunks.resolver },
    now: NOW,
    signal: new AbortController().signal,
    health: healthFixture({ eviction: demand() }),
  } as OperationContext;
}

beforeAll(async () => {
  await activateCoverage();
  await armEviction();
});

it('scores one eligible source of a batch of eight as an eighth and then evicts it', async () => {
  const sourceId = await eligibleSource('operation-evicts', 'S1');
  const operation = episodeEvictOperation(SCALES);
  const ctx = context();

  expect(ctx.health.eviction.eligibleSources).toBe(1);
  expect(operation.relevance(ctx.health)).toBeCloseTo(0.125);

  const outcome = await operation.run(ctx);

  expect(outcome).toMatchObject({ status: 'applied', itemsAffected: 1 });
  expect(await nodeExists(driver, sourceId)).toBe(false);
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('evicted');
  expect(demand().eligibleSources).toBe(0);
});

it('stays selectable on zero fresh demand while a committed removal owes survivor work', async () => {
  const survivorId = 'operation-survivor';
  await seedVectoredEntity(driver, {
    id: survivorId,
    name: 'operation neighbour',
    vector: [0.2, 0.5, 0.9],
    now: NOW,
  });
  const sourceId = await eligibleSource('operation-survivor-source', 'S1');
  await upsertEdge(driver, {
    type: 'CO_OCCURS',
    sourceId,
    targetId: survivorId,
    strength: 0.5,
    confidence: 1,
    signals: ['co_occurrence'],
    provenance: ['reflection_associations'],
    count: 1,
    now: NOW,
  });
  const operation = episodeEvictOperation(SCALES);

  expect((await operation.run(context())).itemsAffected).toBeGreaterThanOrEqual(1);
  expect(listRunnableSurvivorWork(store.db, NOW, 8).length).toBeGreaterThanOrEqual(1);

  // Nothing fresh qualifies now, and the reading still calls for a run because a receipt bought
  // the work that is owed.
  const owed = demand();
  expect(owed.eligibleSources).toBe(0);
  expect(operation.relevance(healthFixture({ eviction: owed }))).toBe(1);

  const drained = await operation.run(context());
  expect(drained.itemsAffected).toBeGreaterThanOrEqual(1);
  expect(listRunnableSurvivorWork(store.db, NOW, 8)).toEqual([]);
});

it('reports a source the guard pinned without removing anything', async () => {
  const sourceId = await eligibleSource('operation-pinned', 'S1');
  await seedUnknownEdge(driver, {
    fromId: sourceId,
    toId: sessionOf(sourceId),
    relationId: 'operation-pinned-edge',
  });

  const outcome = await episodeEvictOperation(SCALES).run(context());

  expect(outcome.itemsAffected).toBe(0);
  expect(outcome.detail).toContain('1 pinned under the guard');
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('declines rather than reaching for a coordinator it was not composed with', async () => {
  const ctx = { ...context(), narratives: undefined } as OperationContext;
  const outcome = await episodeEvictOperation(SCALES).run(ctx);
  expect(outcome).toMatchObject({ status: 'noop', itemsAffected: 0 });
  expect(outcome.detail).toContain('no publication coordinator composed');
});
