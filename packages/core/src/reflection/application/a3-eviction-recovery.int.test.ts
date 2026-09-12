import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';

import { SURVIVOR_RETRY_DELAY_MS } from './context-vector-sync.js';
import { durableEligibility } from './eviction-eligibility.js';
import { planRemoval } from './eviction-plan.js';
import {
  activateCoverage,
  armEviction,
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
  edgeStrengthOf,
  moveEdgeStrength,
  nodeExists,
  seedUnknownEdge,
  seedUnvectoredNeighbour,
  seedVectoredEntity,
  storedVectors,
} from '../../infrastructure/graph/test-support/a3-eviction-graph.fixture.js';
import { renameNodeId } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
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
    acceptedReferenceVersion: candidate.acceptedReferenceVersion,
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

/** The association edge each survivor fixture wrote, so a case can move and restore its weight. */
const associations = new Map<string, string>();

function associationOf(survivorId: string): string {
  const relationId = associations.get(survivorId);
  if (relationId === undefined) {
    throw new Error(`no association recorded for ${survivorId}`);
  }
  return relationId;
}

/** A source with one disposable association to a retained, vectored neighbour. */
async function sourceWithSurvivor(
  identity: string,
  survivorId: string,
  strength = 0.5,
): Promise<string> {
  await seedVectoredEntity(driver, {
    id: survivorId,
    name: `${identity} neighbour`,
    vector: VECTOR,
    now: NOW,
  });
  const sourceId = await eligibleSource(identity, 'S1');
  const edge = await upsertEdge(driver, {
    type: 'CO_OCCURS',
    sourceId,
    targetId: survivorId,
    strength,
    confidence: 1,
    signals: ['co_occurrence'],
    provenance: ['reflection_associations'],
    count: 1,
    now: NOW,
  });
  associations.set(survivorId, edge.id);
  return sourceId;
}

beforeAll(async () => {
  await activateCoverage();
  await armEviction();
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
  // This source has no disposable association, so the attempt prepared no obligation at all.
  // That it recorded none is what is asserted here; what happens to one it DID record is the
  // discard-then-retry case below.
  expect(survivorWorkOf(store.db, operationId)).toEqual([]);
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

  const repaired = await repairSurvivors({ driver, db: store.db, publications, now: NOW }, 8);

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

it('carries a discarded attempt\u2019s obligation into the attempt that commits', async () => {
  const survivorId = 'survivor-readopted';
  const sourceId = await sourceWithSurvivor('recover-readopt', survivorId, 0.5);
  const first = randomUUID();
  const nomination = await payloadFor(sourceId);
  const association = associationOf(survivorId);
  const strength = await edgeStrengthOf(driver, association);
  expect(strength).toBeDefined();

  // Interrupted after its durable preparation, with a preserved weight moved underneath it so the
  // recheck refuses on the way back and the attempt is discarded rather than resumed.
  atBoundary(
    'prepared',
    async () => {
      await moveEdgeStrength(driver, association, 0.25);
      throw new Error('interrupted after preparation');
    },
    first,
  );
  await expect(
    publications.publish({ kind: 'episode_eviction', operationId: first, payload: nomination }),
  ).rejects.toThrow();
  expect(await publications.recover()).toMatchObject({
    status: 'deferred',
    reason: 'removal_categories_moved',
  });

  // The obligation is parked, not lost: still this source's, still owed, and not runnable.
  const parked = survivorWorkOf(store.db, first);
  expect(parked.map((task) => [task.nodeId, task.state])).toEqual([[survivorId, 'obsolete']]);
  expect(listRunnableSurvivorWork(store.db, NOW, 8)).toEqual([]);

  // The weight goes back to what it was, the source qualifies again, and a second attempt takes it.
  await moveEdgeStrength(driver, association, strength ?? 0.5);
  const second = randomUUID();
  const outcome = await publications.publish({
    kind: 'episode_eviction',
    operationId: second,
    payload: await payloadFor(sourceId),
  });

  expect(outcome.status).toBe('acknowledged');
  // Re-adopted rather than duplicated: one row, owned by the attempt that committed, and the
  // result reports the obligation this attempt actually holds.
  expect(survivorWorkOf(store.db, first)).toEqual([]);
  expect(survivorWorkOf(store.db, second).map((task) => task.nodeId)).toEqual([survivorId]);
  expect(outcome.status === 'acknowledged' ? outcome.result : undefined).toMatchObject({
    survivorTasks: 1,
  });
  const runnable = listRunnableSurvivorWork(store.db, NOW, 8).filter(
    (task) => task.nodeId === survivorId,
  );
  expect(runnable.length).toBe(1);

  // And it completes exactly once: the second pass finds this operation owing nothing.
  const repaired = await repairSurvivors({ driver, db: store.db, publications, now: NOW }, 8);
  expect(repaired.cleared + repaired.recomputed).toBeGreaterThanOrEqual(1);
  expect(
    listRunnableSurvivorWork(store.db, NOW, 8).filter((task) => task.nodeId === survivorId),
  ).toEqual([]);
  expect(survivorWorkOf(store.db, second).map((task) => task.state)).toEqual(['completed']);
});

it('settles a survivor that carries no context vector instead of retrying it forever', async () => {
  const survivorId = 'survivor-unvectored';
  await seedUnvectoredNeighbour(driver, { id: survivorId, now: NOW });
  const sourceId = await eligibleSource('recover-unvectored', 'S1');
  const edge = await upsertEdge(driver, {
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
  expect(edge.id).toBeDefined();
  const operationId = randomUUID();

  expect(
    (
      await publications.publish({
        kind: 'episode_eviction',
        operationId,
        payload: await payloadFor(sourceId),
      })
    ).status,
  ).toBe('acknowledged');

  const repaired = await repairSurvivors({ driver, db: store.db, publications, now: NOW }, 8);

  expect(repaired.classified).toBeGreaterThanOrEqual(1);
  // Settled from durable state with what it actually is, not deferred into a fifteen-minute loop
  // nothing can ever end.
  expect(survivorWorkOf(store.db, operationId).map((task) => task.state)).toEqual(['completed']);
  expect(
    listRunnableSurvivorWork(store.db, NOW, 8).filter((task) => task.nodeId === survivorId),
  ).toEqual([]);
});

/**
 * The other half of the survivor contract under the guard: the recomputation itself interrupted.
 *
 * Adopted from the review's own probe. `interruptAt` with no operation id matches whatever
 * identity the operation mints for itself, which is what lets a case reach a publication it does
 * not name. What it pins is the ordering: the graph write is durable before the obligation is
 * settled, the recovery settles it exactly once, and a second recovery has nothing to do.
 */
it('finishes a context_vector_sync interrupted before its acknowledgment', async () => {
  const survivorId = 'survivor-interrupted-sync';
  const sourceId = await sourceWithSurvivor('recover-interrupted-sync', survivorId);
  expect((await storedVectors(driver, survivorId)).context).toBeDefined();

  const operationId = randomUUID();
  expect(
    (
      await publications.publish({
        kind: 'episode_eviction',
        operationId,
        payload: await payloadFor(sourceId),
      })
    ).status,
  ).toBe('acknowledged');
  expect(
    listRunnableSurvivorWork(store.db, NOW, 8).filter((task) => task.nodeId === survivorId).length,
  ).toBe(1);

  interruptAt('before_ack');
  await expect(
    repairSurvivors({ driver, db: store.db, publications, now: NOW }, 8),
  ).rejects.toThrow();

  // The clear committed with the graph; the obligation has not been settled by it.
  expect((await storedVectors(driver, survivorId)).context).toBeUndefined();
  expect(survivorWorkOf(store.db, operationId).map((task) => task.state)).not.toEqual([
    'completed',
  ]);

  expect(await publications.recover()).toMatchObject({ status: 'acknowledged' });
  expect(survivorWorkOf(store.db, operationId).map((task) => task.state)).toEqual(['completed']);
  expect(
    listRunnableSurvivorWork(store.db, NOW, 8).filter((task) => task.nodeId === survivorId),
  ).toEqual([]);
  expect(await publications.recover()).toBeUndefined();
}, 120_000);

/**
 * A batch in which every nominated survivor is gone, which is the case that regressed.
 *
 * `node_absent` is a TERMINAL outcome — nothing a recomputation could ever deliver — so the
 * receipt that names it is what finishes the obligation. `check` therefore has to let such a
 * batch commit: counting an absent member as a moved binding refuses the publication, settles
 * nothing, and re-offers the same work on every tick for ever. The pre-conversion pass settled
 * it directly, so this is the one property the rewiring could lose silently.
 *
 * The node is moved out from under its id rather than deleted, which is the workspace's
 * reversible technique for producing exactly this state: an obligation whose node the revision
 * read cannot find.
 */
it('settles a survivor whose node is gone rather than refusing the batch for ever', async () => {
  const survivorId = 'survivor-vanished';
  const sourceId = await sourceWithSurvivor('recover-vanished', survivorId);
  const operationId = randomUUID();
  expect(
    (
      await publications.publish({
        kind: 'episode_eviction',
        operationId,
        payload: await payloadFor(sourceId),
      })
    ).status,
  ).toBe('acknowledged');
  expect(
    listRunnableSurvivorWork(store.db, NOW, 8).filter((task) => task.nodeId === survivorId).length,
  ).toBe(1);

  await renameNodeId(driver, survivorId, `${survivorId}-moved`);
  expect(await nodeExists(driver, survivorId)).toBe(false);

  const repaired = await repairSurvivors({ driver, db: store.db, publications, now: NOW }, 8);

  // The publication committed a receipt of nothing but a terminal hold, rather than refusing.
  expect(repaired.refusal).toBeUndefined();
  expect(repaired.classified).toBeGreaterThanOrEqual(1);
  expect(survivorWorkOf(store.db, operationId).map((task) => task.state)).toEqual(['completed']);
  expect(
    listRunnableSurvivorWork(store.db, NOW, 8).filter((task) => task.nodeId === survivorId),
  ).toEqual([]);

  // And a second pass finds nothing owed, which is what "for ever" would have broken.
  const again = await repairSurvivors({ driver, db: store.db, publications, now: NOW }, 8);
  expect(again.attempted).toBe(0);

  await renameNodeId(driver, `${survivorId}-moved`, survivorId);
}, 120_000);

/**
 * A hold does not make the obligation runnable again immediately.
 *
 * The pre-conversion pass deferred a moved neighbourhood by fifteen minutes with the reason
 * stated at its constant: it comes back on the ordinary cadence, not immediately and not never.
 * Deferring to the acknowledgment instant instead leaves `due_at <= now` true, so the next tick
 * re-binds and re-publishes the same member against the same unmoved neighbourhood. The driving
 * operation's bucket happens to be the same quarter-hour today, which is exactly why the floor
 * has to be asserted here rather than assumed from the schedule.
 */
it('leaves a held survivor owed, and not runnable again until its retry delay', async () => {
  const survivorId = 'survivor-held';
  const sourceId = await sourceWithSurvivor('recover-held', survivorId);
  const operationId = randomUUID();
  expect(
    (
      await publications.publish({
        kind: 'episode_eviction',
        operationId,
        payload: await payloadFor(sourceId),
      })
    ).status,
  ).toBe('acknowledged');

  // The neighbourhood moves between the binding and the guard, which is what a hold is for: the
  // hook runs after the check and before the graph write, under the guard this attempt holds. A
  // NEW neighbour rather than the evicted source, which no longer exists to link to.
  await seedVectoredEntity(driver, {
    id: 'survivor-held-latecomer',
    name: 'a neighbour that arrives mid-attempt',
    vector: VECTOR,
    now: NOW,
  });
  atBoundary(
    'prepared',
    async () => {
      await upsertEdge(driver, {
        type: 'CO_OCCURS',
        sourceId: survivorId,
        targetId: 'survivor-held-latecomer',
        strength: 0.75,
        confidence: 1,
        signals: ['co_occurrence'],
        provenance: ['reflection_associations'],
        count: 2,
        now: NOW,
      });
    },
    '',
  );

  const repaired = await repairSurvivors({ driver, db: store.db, publications, now: NOW }, 8);
  expect(repaired.deferred).toBeGreaterThanOrEqual(1);

  // Owed, and out of reach at the ack moment: the delay, not the bucket, is what spaces it.
  const [held] = survivorWorkOf(store.db, operationId);
  expect(held?.state).toBe('retryable');
  expect(listRunnableSurvivorWork(store.db, NOW, 8).map((task) => task.nodeId)).not.toContain(
    survivorId,
  );
  const afterTheDelay = new Date(NOW.getTime() + SURVIVOR_RETRY_DELAY_MS + 1_000);
  expect(listRunnableSurvivorWork(store.db, afterTheDelay, 8).map((task) => task.nodeId)).toContain(
    survivorId,
  );
}, 120_000);
