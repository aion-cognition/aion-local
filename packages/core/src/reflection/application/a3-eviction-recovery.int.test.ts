import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';

import { durableEligibility } from './eviction-eligibility.js';
import { planRemoval } from './eviction-plan.js';
import {
  activateCoverage,
  atBoundary,
  driver,
  eligibleSource,
  interruptAt,
  NOW,
  publications,
  sessionOf,
  store,
} from './test-support/a3-eviction.fixture.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import {
  nodeExists,
  seedUnknownEdge,
  seedVectoredEntity,
  storedVectors,
} from '../../infrastructure/graph/test-support/a3-eviction-graph.fixture.js';
import {
  listRunnableSurvivorWork,
  readEvictionManifest,
  survivorWorkOf,
} from '../../infrastructure/sqlite/eviction-manifests.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import { repairSurvivors } from '../../introspection/application/operations/eviction-repair.js';

/**
 * What a crash leaves and what finishes it, plus the work a committed removal owes the nodes that
 * stayed.
 *
 * The ordering rule these cases exist to hold is that a survivor task is bought by a receipt and
 * by nothing else. An attempt interrupted before its graph write leaves every task pinned and the
 * projection resident; an attempt interrupted after the commit and before the acknowledgment
 * leaves the removal done and finishes exactly once. Neither of those is inferable from an
 * absence, which is why each is asked of the durable records rather than of the graph.
 */

const POLICY = { now: NOW, minAgeMs: 0 };
const VECTOR = [0.6, 0.4, 0.2];

async function payloadFor(sourceId: string): Promise<Record<string, unknown>> {
  const verdict = durableEligibility(store.db, sourceId, POLICY);
  if (verdict.status !== 'eligible') {
    throw new Error(`fixture source is not eligible: ${verdict.reason}`);
  }
  const planned = await inWriteTransaction(driver, (tx) =>
    planRemoval(store.db, tx, verdict.candidate),
  );
  if (planned.status !== 'planned') {
    throw new Error(`fixture source could not be planned: ${planned.reason}`);
  }
  const { candidate } = verdict;
  const { plan } = planned;
  return {
    sourceId: candidate.sourceId,
    sessionId: candidate.sessionId,
    observedAt: NOW.toISOString(),
    coverageEpoch: candidate.coverageEpoch,
    chunkId: candidate.chunkId,
    publishedRevisionNo: candidate.publishedRevisionNo,
    processingGeneration: candidate.processingGeneration,
    operationalRevision: candidate.operationalRevision,
    readinessPolicyRevision: candidate.readinessPolicyRevision,
    projectionGeneration: candidate.projectionGeneration,
    qualifiedAt: candidate.qualifiedAt,
    nodeIds: [...plan.nodeIds],
    relationIds: [...plan.relationIds],
    nodeDigest: plan.nodeDigest,
    categoryDigest: plan.categoryDigest,
    survivors: plan.survivors.map((entry) => ({ ...entry })),
    contentDigests: { ...candidate.contentDigests },
    searchCoverageProof: { ...candidate.searchCoverageProof },
    dependencies: candidate.dependencies.map((entry) => ({ ...entry })),
  };
}

/** A source with one disposable association to a retained, vectored neighbour. */
async function sourceWithSurvivor(identity: string, survivorId: string): Promise<string> {
  await seedVectoredEntity(driver, {
    id: survivorId,
    name: `${identity} neighbour`,
    vector: VECTOR,
    now: NOW,
  });
  const sourceId = await eligibleSource(identity, 'S1');
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
  return sourceId;
}

beforeAll(async () => {
  await activateCoverage();
});

it('finishes an eviction interrupted after its commit exactly once', async () => {
  const sourceId = await eligibleSource('recover-before-ack', 'S1');
  const operationId = randomUUID();
  const payload = await payloadFor(sourceId);
  interruptAt('before_ack', operationId);

  await expect(
    publications.publish({ kind: 'episode_eviction', operationId, payload }),
  ).rejects.toThrow();

  // The graph write committed and the acknowledgment did not, which is the one state a receipt
  // decides rather than an absence.
  expect(await nodeExists(driver, sourceId)).toBe(false);
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('retiring');

  const recovered = await publications.recover();
  expect(recovered).toMatchObject({ status: 'acknowledged', operationId });
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('evicted');
  expect(await publications.recover()).toBeUndefined();
});

it('resumes an attempt interrupted before its graph write', async () => {
  const sourceId = await eligibleSource('recover-prepared', 'S1');
  const operationId = randomUUID();
  const payload = await payloadFor(sourceId);
  interruptAt('prepared', operationId);

  await expect(
    publications.publish({ kind: 'episode_eviction', operationId, payload }),
  ).rejects.toThrow();

  // Nothing was removed and the transition is durable: the source is retiring under the
  // generation this attempt spent, and the work it owes is written and not runnable.
  expect(await nodeExists(driver, sourceId)).toBe(true);
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('retiring');
  expect(readEvictionManifest(store.db, operationId)).toBeDefined();

  const recovered = await publications.recover();
  expect(recovered).toMatchObject({ status: 'acknowledged', operationId });
  expect(await nodeExists(driver, sourceId)).toBe(false);
});

it('restores a retiring source when its preconditions moved under the interruption', async () => {
  const sourceId = await eligibleSource('recover-discard', 'S1');
  const operationId = randomUUID();
  const payload = await payloadFor(sourceId);
  const generationBefore = readSourceResidency(store.db, sourceId)?.projectionGeneration ?? 0;
  atBoundary(
    'prepared',
    async () => {
      await seedUnknownEdge(driver, {
        fromId: sourceId,
        toId: sessionOf(sourceId),
        relationId: `discard-edge-${sourceId}`,
      });
      throw new Error('interrupted after preparation');
    },
    operationId,
  );

  await expect(
    publications.publish({ kind: 'episode_eviction', operationId, payload }),
  ).rejects.toThrow();

  const settled = await publications.recover();
  expect(settled).toMatchObject({ status: 'deferred', reason: 'unknown_relationship_type' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
  const residency = readSourceResidency(store.db, sourceId);
  expect(residency?.state).toBe('resident');
  // Another generation, not the one the attempt spent: a late writer holding the old number
  // cannot land in the place the next attempt will take.
  expect(residency?.projectionGeneration).toBeGreaterThan(generationBefore + 1);
  // The obligations the attempt recorded are preserved and still not runnable.
  expect(survivorWorkOf(store.db, operationId).length).toBe(0);
});

it('keeps survivor work unrunnable until a receipt proves the removal', async () => {
  const survivorId = 'survivor-pinned';
  const sourceId = await sourceWithSurvivor('recover-survivor-pinned', survivorId);
  const operationId = randomUUID();
  const payload = await payloadFor(sourceId);
  interruptAt('prepared', operationId);

  await expect(
    publications.publish({ kind: 'episode_eviction', operationId, payload }),
  ).rejects.toThrow();

  expect(survivorWorkOf(store.db, operationId).map((task) => task.nodeId)).toEqual([survivorId]);
  expect(listRunnableSurvivorWork(store.db, NOW, 8)).toEqual([]);

  expect(await publications.recover()).toMatchObject({ status: 'acknowledged' });
  expect(listRunnableSurvivorWork(store.db, NOW, 8).map((task) => task.nodeId)).toEqual([
    survivorId,
  ]);
});

it('clears a survivor context vector whose last vectored neighbour was removed', async () => {
  const survivorId = 'survivor-cleared';
  const sourceId = await sourceWithSurvivor('recover-survivor-cleared', survivorId);
  const before = await storedVectors(driver, survivorId);
  expect(before.context).toBeDefined();

  const operationId = randomUUID();
  const outcome = await publications.publish({
    kind: 'episode_eviction',
    operationId,
    payload: await payloadFor(sourceId),
  });
  expect(outcome.status).toBe('acknowledged');

  const repaired = await repairSurvivors({ driver, db: store.db, now: NOW }, 8);

  expect(repaired.deferred).toBe(0);
  expect(repaired.cleared).toBeGreaterThanOrEqual(1);
  const after = await storedVectors(driver, survivorId);
  expect(after.context).toBeUndefined();
  // What the node itself says is unchanged by what stopped standing next to it.
  expect(after.content).toEqual(before.content);
  // Acknowledged durably, so a later pass finds this operation owing nothing rather than
  // recomputing the same neighbourhood again.
  expect(
    listRunnableSurvivorWork(store.db, NOW, 8).filter((task) => task.operationId === operationId),
  ).toEqual([]);
});
