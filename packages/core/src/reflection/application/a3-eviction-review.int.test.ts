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
  prepareMaterializedLinkVersion,
  prepareRetirementVersion,
} from '../../infrastructure/sqlite/evidence-link-materialization.js';
import {
  acknowledgeStatedLinkVersions,
  evidenceLinkId,
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
  readSourceParts,
  readSourcePartTurnIds,
  recordSourceParts,
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

it('refuses a prepared attempt when a re-verification rewrites a part hash under it', async () => {
  const sourceId = await eligibleSource('evict-digest-rewrite', 'S1');
  const nomination = await nominate(sourceId);

  // The production writer the re-verification producer uses: `recordSourceParts` refreshes a
  // part's content hash unconditionally and preserves its identity and clocks, so the turn set
  // the candidate compares does not move.
  const parts = readSourceParts(store.db, sourceId);
  expect(parts.length).toBeGreaterThan(0);
  recordSourceParts(
    store.db,
    sourceId,
    parts.map((part) => ({
      partKind: part.partKind as 'turn' | 'observation' | 'tool_execution',
      ordinal: part.ordinal,
      contentHash: `reverified-${part.contentHash}`,
      ...(part.turnId === null ? {} : { turnId: part.turnId }),
      ...(part.role === null ? {} : { role: part.role }),
    })),
  );
  expect(readSourcePartTurnIds(store.db, sourceId)).toEqual(nomination.candidate.turnIds);

  const outcome = await publishEviction(nomination);

  // Refused, and refused EARLIER than the digest comparison: the search projection's coverage is
  // keyed on the recorded hash, so a part whose hash moved is uncovered, and condition 6 answers
  // before condition 2's proof is compared. Re-indexing cannot clear it either — the resolver
  // will not resolve a source whose recorded hash disagrees with its bytes. Nothing is removed on
  // any of those paths, which is what this case is about.
  expect(outcome).toMatchObject({ status: 'deferred', reason: 'search_unindexed_parts' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('refuses when the archive digest the manifest proves no longer matches the record', async () => {
  const sourceId = await eligibleSource('evict-digest-compare', 'S1');
  const nomination = await nominate(sourceId);

  // Constructed, not written by a production path: `recordSourceRecord` COALESCEs both
  // record-level digests, so nothing in the workspace can rewrite one today. The comparison is
  // defence in depth behind the search fence above, and this is what proves the comparison itself
  // rather than the fence in front of it.
  store.db
    .prepare('UPDATE source_records SET verified_content_digest = ? WHERE source_id = ?')
    .run(`reverified-${sourceId}`, sourceId);

  const outcome = await publishEviction(nomination);

  expect(outcome).toMatchObject({ status: 'deferred', reason: 'content_digests_changed' });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('names the materialization producer when a legacy version is the one left unsettled', async () => {
  const sourceId = await eligibleSource('evict-materialized-owed', 'S1');
  expect(durableEligibility(store.db, sourceId, POLICY).status).toBe('eligible');

  // The legacy producer's own preparation writer, left unacknowledged. It is not a statement
  // anybody made about this source, and the pin says so.
  prepareMaterializedLinkVersion(store.db, {
    linkId: evidenceLinkId('mention', 'retained_node', sourceId, 'materialized-target'),
    kind: 'mention',
    qualifier: 'retained_node',
    fromId: sourceId,
    toId: 'materialized-target',
    originalRelId: `rel-${sourceId}`,
    operationId: `owed-materialization-${sourceId}`,
    operationKey: `owed-materialization-key-${sourceId}`,
    recordedValues: {},
    temporalProof: {},
    observedAt: NOW,
  });

  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'materialization_settlement_owed',
  });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

it('names the merge when a retirement version is the one left unsettled', async () => {
  const sourceId = await eligibleSource('evict-retired-owed', 'S1');
  const linkId = statedLinkId('confirms', 'retained_node', sourceId, 'retired-target');
  const settled = `settled-statement-${sourceId}`;
  prepareStatedLinkVersion(store.db, {
    linkId,
    kind: 'confirms',
    qualifier: 'retained_node',
    fromId: sourceId,
    toId: 'retired-target',
    operationId: settled,
    operationKey: `${settled}-key`,
    recordedValues: {},
    temporalProof: {},
    observedAt: NOW,
    referenceSourceId: sourceId,
    referenceVersion: 1,
  });
  acknowledgeStatedLinkVersions(store.db, settled, NOW.toISOString(), NOW.toISOString());
  expect(durableEligibility(store.db, sourceId, POLICY).status).toBe('eligible');

  // A merge's retirement, appended and not yet acknowledged. The statement under it is settled;
  // what is owed is the close, and the pin names that rather than the acceptance.
  prepareRetirementVersion(store.db, {
    linkId,
    operationId: `owed-retirement-${sourceId}`,
    operationKey: `owed-retirement-key-${sourceId}`,
    recordedValues: {},
    temporalProof: {},
    observedAt: NOW,
  });

  expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
    status: 'pinned',
    reason: 'retirement_settlement_owed',
  });
  expect(await nodeExists(driver, sourceId)).toBe(true);
});

// Constructed, not written by a production path: the three preparers write `stated`,
// `materialized` and `retired` and nothing else. `closed` is the fourth state probe-incidence.ts
// already reads for; `constructor` is a name Object's prototype answers to, which a pin table
// asked by plain indexing would resolve to a reason nobody wrote.
it.each(['closed', 'constructor'])(
  'pins without naming an owner when the unsettled class is %s, which no writer declares',
  async (state) => {
    const sourceId = await eligibleSource(`evict-unnamed-${state}`, 'S1');
    const target = `unnamed-${state}-target`;
    const linkId = evidenceLinkId('mention', 'retained_node', sourceId, target);
    expect(durableEligibility(store.db, sourceId, POLICY).status).toBe('eligible');

    store.db
      .prepare(
        `INSERT INTO evidence_links (link_id, kind, qualifier, from_id, to_id, record_source,
           created_at) VALUES (?, 'mention', 'retained_node', ?, ?, 'legacy_narrative', ?)`,
      )
      .run(linkId, sourceId, target, NOW.toISOString());
    store.db
      .prepare(
        `INSERT INTO evidence_link_versions (link_id, version, state, recorded_values_json,
           temporal_proof_json, observed_at, operation_key) VALUES (?, 1, ?, '{}', '{}', ?, ?)`,
      )
      .run(linkId, state, NOW.toISOString(), `unnamed-${state}-key-${sourceId}`);

    expect(durableEligibility(store.db, sourceId, POLICY)).toEqual({
      status: 'pinned',
      reason: 'link_settlement_owed',
    });
    expect(await nodeExists(driver, sourceId)).toBe(true);
  },
);

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
