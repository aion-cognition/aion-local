import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';

import { durableEligibility, type EvictionCandidate } from './eviction-eligibility.js';
import { planRemoval, type PlannedRemoval } from './eviction-plan.js';
import {
  acceptEpisode,
  activateCoverage,
  driver,
  eligibleSource,
  finishReadiness,
  indexSource,
  NOW,
  publications,
  sealAndPublish,
  sessionOf,
  store,
} from './test-support/a3-eviction.fixture.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import {
  moveEdgeStrength,
  nodeExists,
  seedForeignEndpointEdge,
  seedStrayTurn,
  seedUnknownEdge,
  setNodeLabel,
} from '../../infrastructure/graph/test-support/a3-eviction-graph.fixture.js';
import { countNodesWithId } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { readEvictionManifest } from '../../infrastructure/sqlite/eviction-manifests.js';
import {
  prepareStatedLinkVersion,
  statedLinkId,
} from '../../infrastructure/sqlite/evidence-links.js';
import {
  completeSourceWork,
  createSourceWork,
  readActiveGeneration,
} from '../../infrastructure/sqlite/processing-generations.js';
import {
  acceptReferenceBatch,
  readSourcePartTurnIds,
} from '../../infrastructure/sqlite/source-identity.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';

/**
 * The destructive battery. Every case runs against real SQLite and a throwaway Neo4j, and every
 * one of them removes only data the fixture wrote for it a moment earlier.
 *
 * What is under test is the exact set. Nomination derives the removal set outside the guard, the
 * guard derives it again, and the two are compared as values — so most of these cases move the
 * substrate between those two derivations and assert that the attempt refuses with a named reason
 * and the graph is untouched. The cases that do remove something assert what stayed.
 */

const POLICY = { now: NOW, minAgeMs: 0 };

type Nomination = { readonly candidate: EvictionCandidate; readonly plan: PlannedRemoval };

async function nominate(sourceId: string): Promise<Nomination> {
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
  return { candidate: verdict.candidate, plan: planned.plan };
}

function payloadOf(nomination: Nomination): Record<string, unknown> {
  const { candidate, plan } = nomination;
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

async function publishEviction(nomination: Nomination, operationId = randomUUID()) {
  return publications.publish({
    kind: 'episode_eviction',
    operationId,
    payload: payloadOf(nomination),
  });
}

beforeAll(async () => {
  await activateCoverage();
});

it('removes one source projection exactly and leaves everything it stood beside', async () => {
  const sourceId = await eligibleSource('evict-happy', 'S1', true);
  const turnIds = readSourcePartTurnIds(store.db, sourceId);
  expect(turnIds.length).toBeGreaterThan(0);
  const sessionId = sessionOf(sourceId);

  const outcome = await publishEviction(await nominate(sourceId));

  expect(outcome.status).toBe('acknowledged');
  expect(await nodeExists(driver, sourceId)).toBe(false);
  for (const turnId of turnIds) {
    expect.soft(await nodeExists(driver, turnId)).toBe(false);
  }
  // The session the episode hung off is not raw capture and was never in the set.
  expect(await countNodesWithId(driver, 'Session', sessionId)).toBe(1);
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('evicted');
  const manifest = readEvictionManifest(store.db, outcome.operationId);
  expect(JSON.parse(manifest?.expectedOutcomeJson ?? '{}')).toMatchObject({
    nodes: turnIds.length + 1,
  });
});

it('keeps the durable records an evicted source stood behind', async () => {
  const sourceId = await eligibleSource('evict-durable', 'S1');
  const before = readSourcePartTurnIds(store.db, sourceId);

  expect((await publishEviction(await nominate(sourceId))).status).toBe('acknowledged');

  // The occurrence, its parts and its chunk membership outlive the projection. What changed is
  // storage, which the fence says by pinning on residency rather than on a missing record.
  expect(readSourcePartTurnIds(store.db, sourceId)).toEqual(before);
  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'residency_evicted',
  });
});

it('refuses when an unclassified edge appears between nomination and the guard', async () => {
  const sourceId = await eligibleSource('evict-unknown-edge', 'S1');
  const nomination = await nominate(sourceId);
  await seedUnknownEdge(driver, {
    fromId: sourceId,
    toId: sessionOf(sourceId),
    relationId: 'stray-unknown-edge',
  });

  const outcome = await publishEviction(nomination);

  expect(outcome).toMatchObject({ status: 'deferred', reason: 'unknown_relationship_type' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('refuses when a preserved payload moves under a prepared attempt', async () => {
  const sourceId = await eligibleSource('evict-payload', 'S1');
  const nomination = await nominate(sourceId);
  const relationId = nomination.plan.relationIds[0] ?? '';
  // The identities are all still there and the count has not moved. Only the weight has, which
  // is a preserved field, so the category digest the intent bound no longer describes the graph.
  await moveEdgeStrength(driver, relationId, 0.25);

  const outcome = await publishEviction(nomination);

  expect(outcome).toMatchObject({ status: 'deferred', reason: 'removal_categories_moved' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('refuses a source carrying a Turn the part records never captured', async () => {
  const sourceId = await eligibleSource('evict-stray-turn', 'S1');
  const nomination = await nominate(sourceId);
  await seedStrayTurn(driver, { id: 'stray-turn-1', sourceId, now: NOW });

  const outcome = await publishEviction(nomination);

  expect(outcome).toMatchObject({ status: 'deferred', reason: 'projected_turns_disagree' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
  expect(await nodeExists(driver, 'stray-turn-1')).toBe(true);
});

it('pins a source whose chunk has not published, with zero deletions', async () => {
  const sourceId = await acceptEpisode('evict-unpublished', 'S1');
  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'source_not_chunked',
  });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('pins a source that still owes its pipeline, then admits it once the work settles', async () => {
  const sourceId = await acceptEpisode('evict-owed-work', 'S1');
  await sealAndPublish(sourceId);
  // An unclosed inventory is the first thing the fence meets: a generation nobody declared
  // complete is a generation whose owed set nothing has established, which is a stronger refusal
  // than a particular row still being owed.
  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'stage_inventory_incomplete',
  });
  finishReadiness(sourceId);
  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'search_unindexed_parts',
  });
  await indexSource(sourceId);
  expect(durableEligibility(store.db, sourceId, POLICY).status).toBe('eligible');

  // A new obligation arriving on a qualified source takes it back out again. Nothing about the
  // archive, the chunk or the index moved; what moved is what the source still owes.
  const generation = readActiveGeneration(store.db, sourceId);
  const workId = `late-work:${sourceId}`;
  createSourceWork(store.db, {
    workId,
    sourceId,
    processingGeneration: generation?.processingGeneration ?? 1,
    kind: 'reference_settlement',
    workKey: 'late-reference',
    dueAt: NOW,
  });
  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'source_work_outstanding',
  });
  completeSourceWork(store.db, workId, { outcome: 'complete', reason: 'settled' }, NOW);
  expect(durableEligibility(store.db, sourceId, POLICY).status).toBe('eligible');
});

it('holds a qualified source inside its maturation window', async () => {
  const sourceId = await eligibleSource('evict-young', 'S1');
  expect(durableEligibility(store.db, sourceId, { now: NOW, minAgeMs: 86_400_000 })).toEqual({
    status: 'pinned',
    reason: 'qualification_age_unmet',
  });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('refuses every source while the compatibility capability is unestablished', async () => {
  const sourceId = await eligibleSource('evict-capability', 'S1');
  store.db.prepare('UPDATE publication_control SET activation_capability_revision = 0').run();

  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'compatibility_not_established',
  });

  store.db.prepare('UPDATE publication_control SET activation_capability_revision = 1').run();
  expect(durableEligibility(store.db, sourceId, POLICY).status).toBe('eligible');
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('returns the recorded result when the same operation is delivered twice', async () => {
  const sourceId = await eligibleSource('evict-idempotent', 'S1');
  const nomination = await nominate(sourceId);
  const operationId = randomUUID();

  const first = await publishEviction(nomination, operationId);
  const repeat = await publishEviction(nomination, operationId);

  expect(first.status).toBe('acknowledged');
  expect(repeat).toEqual(first);
});

it('refuses when a reference is accepted between nomination and the guard', async () => {
  const sourceId = await eligibleSource('evict-reference-accepted', 'S1');
  const nomination = await nominate(sourceId);

  // The acceptance path's own durable writer. A statement about this source arrived after the
  // removal was decided, so the decision was not taken against it.
  acceptReferenceBatch(store.db, {
    sourceId,
    acceptedHash: `accepted-${sourceId}`,
    receivedAt: NOW,
    operationKey: `late-delivery-${sourceId}`,
    introduced: ['some-target'],
  });

  const outcome = await publishEviction(nomination);

  expect(outcome).toMatchObject({ status: 'deferred', reason: 'reference_accepted' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('pins a source whose accepted statement is still waiting to be published', async () => {
  const sourceId = await eligibleSource('evict-reference-owed', 'S1');
  expect(durableEligibility(store.db, sourceId, POLICY).status).toBe('eligible');

  // Prepared, not acknowledged: the statement is durable and its graph projection is not written.
  // Deleting the projection underneath it would strand a write that names a node about to go.
  prepareStatedLinkVersion(store.db, {
    linkId: statedLinkId('confirms', 'retained_node', sourceId, 'some-retained-node'),
    kind: 'confirms',
    qualifier: 'retained_node',
    fromId: sourceId,
    toId: 'some-retained-node',
    operationId: `owed-reference-${sourceId}`,
    operationKey: `owed-reference-key-${sourceId}`,
    recordedValues: {},
    temporalProof: {},
    observedAt: NOW,
    referenceSourceId: sourceId,
    referenceVersion: 1,
  });

  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'reference_settlement_owed',
  });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('refuses when the archive digest the manifest proves is rewritten under it', async () => {
  const sourceId = await eligibleSource('evict-digest-rewrite', 'S1');
  const nomination = await nominate(sourceId);

  // What T9's guarded re-verification producer does to a source whose bytes it re-read: the part
  // set is unchanged, so nothing else about the candidate moves, and the digest the manifest
  // exists to prove is no longer the one the archive carries.
  store.db
    .prepare('UPDATE source_records SET verified_content_digest = ? WHERE source_id = ?')
    .run(`reverified-${sourceId}`, sourceId);

  const outcome = await publishEviction(nomination);

  expect(outcome).toMatchObject({ status: 'deferred', reason: 'content_digests_changed' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('refuses an edge reaching an endpoint the node registry does not name', async () => {
  const sourceId = await eligibleSource('evict-foreign-endpoint', 'S1');
  const nomination = await nominate(sourceId);
  await seedForeignEndpointEdge(driver, {
    fromId: sourceId,
    relationId: `foreign-edge-${sourceId}`,
    foreignId: `admin-probe-${sourceId}`,
  });

  const outcome = await publishEviction(nomination);

  expect(outcome).toMatchObject({ status: 'deferred', reason: 'endpoint_outside_node_registry' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('refuses a raw container carrying a semantic label as well', async () => {
  const sourceId = await eligibleSource('evict-mixed-labels', 'S1');
  const nomination = await nominate(sourceId);
  await setNodeLabel(driver, { id: sourceId, label: 'Insight', present: true });

  const outcome = await publishEviction(nomination);

  expect(outcome).toMatchObject({ status: 'deferred', reason: 'removal_label_mixed' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
  await setNodeLabel(driver, { id: sourceId, label: 'Insight', present: false });
});
