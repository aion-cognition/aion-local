import { expect, it } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import type { ChunkNarrativeDeps } from './chunk-narrative.js';
import {
  NOW,
  accept,
  body,
  chunks,
  coordinator,
  driver,
  forget,
  prompts,
  scheduleFailure,
  scheduleHide,
  sealAndPublish,
  sessionNodeOf,
  store,
  whileGenerating,
} from './test-support/chunk-lifecycle.fixture.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { walkLineage } from '../../evidence/application/lineage-walk.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import { establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { SUMMARIZED_BY_TYPE } from '../../infrastructure/graph/narrative-queries.js';
import {
  countEdges,
  countNodesWithId,
  renameNodeId,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { listChunkMembers } from '../../infrastructure/sqlite/chunk-manifest.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import {
  acknowledgeStatedLinkVersions,
  prepareStatedLinkVersion,
  statedLinkId,
} from '../../infrastructure/sqlite/evidence-links.js';
import { publishedScopeToken } from '../../infrastructure/sqlite/evidence-scope.js';
import { listAllocatedRevisions } from '../../infrastructure/sqlite/narrative-allocations.js';
import {
  readCitationsFrom,
  readCitationsOf,
} from '../../infrastructure/sqlite/narrative-citations.js';
import {
  CHUNK_REVISION_FAMILY,
  allocateNarrativeRevision,
  nominateRetryableRevisions,
  readNarrativeRevision,
  readPublishedHead,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { transitionSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';

/**
 * The publication half: the guard's refusals, recovery, residency, what a run leaves runnable,
 * and what a later reader can walk.
 *
 * Same harness as the seal battery beside it, and the same rule about model clients: nothing in
 * this import graph constructs one.
 */

it('defers a publication whose head moved under it, and publishes nothing', async () => {
  const only = await accept('session-race', 'kappa');
  const chunkId = await sealAndPublish('session-race');
  const first = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(first.status).toBe('published');

  // A second attempt carrying the head the first one saw. The guard reads the ACTUAL head, so
  // an output prepared against a superseded one is refused rather than becoming the head.
  const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  const outcome = await coordinator.publish({
    kind: 'narrative_publish',
    operationId: `stale-head:${chunkId}`,
    payload: {
      chunkId,
      sessionId: sessionNodeOf(only),
      revisionNo: allocation.revisionNo,
      nodeId: allocation.nodeId,
      summary: 'a stale answer',
      narrative: 'a stale answer',
      citations: [{ targetId: only, targetKind: 'source' }],
      sentenceCount: 1,
      coverage: 1,
      occurredAt: NOW.toISOString(),
      members: [{ sourceId: only, residency: 'resident', projectionGeneration: 0 }],
      coverageGaps: [],
      dependencies: [],
      coverageEpoch: readCurrentCoverageContract(store.db)?.epoch ?? '',
      expectedHead: null,
    },
  });
  expect(outcome.status).toBe('deferred');
  if (outcome.status !== 'acknowledged') {
    expect(outcome.reason).toBe('published_head_moved');
  }
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);
  expect(await countNodesWithId(driver, 'Narrative', allocation.nodeId)).toBe(0);
});

it('finishes a publication interrupted between the graph write and the manifest, exactly once', async () => {
  const only = await accept('session-crash', 'lambda');
  const chunkId = await sealAndPublish('session-crash');
  scheduleFailure('before_ack');
  await expect(publishChunkNarrative(chunks, chunkId, { now: NOW })).rejects.toThrow();

  // The node and the receipt are committed; the manifest has not caught up yet.
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();
  const recovered = await coordinator.recover();
  expect(recovered?.status).toBe('acknowledged');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);

  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(head).toBeDefined();
  // Exactly once: a second recovery adds no citation and moves no head.
  const citations = readCitationsFrom(store.db, head?.nodeId ?? '');
  expect(await coordinator.recover()).toBeUndefined();
  expect(readCitationsFrom(store.db, head?.nodeId ?? '')).toEqual(citations);
  expect(citations.map((row) => row.targetId)).toEqual([only]);
});

it('gives an evicted member no edge and keeps its membership and citations', async () => {
  const resident = await accept('session-evicted', 'mu');
  const evicted = await accept('session-evicted', 'nu');
  transitionSourceResidency(store.db, {
    sourceId: evicted,
    state: 'evicted',
    operationId: 'evict-nu',
    transitionedAt: NOW,
  });
  const chunkId = await sealAndPublish('session-evicted');
  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('published');
  if (report.status !== 'published') {
    return;
  }
  expect(listChunkMembers(store.db, chunkId)).toEqual([resident, evicted]);
  expect(await countEdges(driver, SUMMARIZED_BY_TYPE, resident, report.nodeId)).toBe(1);
  expect(await countEdges(driver, SUMMARIZED_BY_TYPE, evicted, report.nodeId)).toBe(0);
  // The evidence is unchanged by eviction, so the evicted member is still submitted and cited.
  expect(prompts[0]).toContain(body('nu'));
  expect(
    readCitationsFrom(store.db, report.nodeId)
      .map((row) => row.targetId)
      .sort(),
  ).toEqual([resident, evicted].sort());
});

it('defers rather than skipping a member the records call resident with no projection', async () => {
  await accept('session-missing', 'xi');
  const vanished = await accept('session-missing', 'omicron');
  const chunkId = await sealAndPublish('session-missing');
  await renameNodeId(driver, vanished, `${vanished}-hidden`);

  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('deferred');
  if (report.status === 'deferred') {
    expect(report.reason).toBe('member_projection_missing');
  }
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();
  // The guard was released rather than held: nothing is pending and other writers can publish.
  expect(coordinator.hasPending()).toBe(false);

  // Restored, the same chunk publishes, and its edge names the projection that came back.
  await renameNodeId(driver, `${vanished}-hidden`, vanished);
  const republished = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(republished.status).toBe('published');
  if (republished.status === 'published') {
    expect(await countEdges(driver, SUMMARIZED_BY_TYPE, vanished, republished.nodeId)).toBe(1);
  }
});

it('refuses the whole write when a projection goes between the check and the edge', async () => {
  const present = await accept('session-vanish', 'rho');
  const vanishing = await accept('session-vanish', 'sigma');
  const chunkId = await sealAndPublish('session-vanish');
  // Deleted after the check passed and before the graph transaction runs, which is the window
  // the signed text calls an inconsistency rather than a member to skip.
  scheduleHide(vanishing);
  await expect(publishChunkNarrative(chunks, chunkId, { now: NOW })).rejects.toThrow();
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();
  const attempted = readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, 1);
  expect(attempted?.state).not.toBe('published');
  expect(await countNodesWithId(driver, 'Narrative', attempted?.nodeId ?? '')).toBe(0);
  expect(await countNodesWithId(driver, 'Episode', present)).toBe(1);

  // The pending attempt is finished by recovery once the projection is back, not by skipping it.
  await renameNodeId(driver, `${vanishing}-hidden`, vanishing);
  expect((await coordinator.recover())?.status).toBe('acknowledged');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);
});

/**
 * The distinct rule the seal-time eligibility fix must not weaken. A member whose evidence was
 * proved when its membership froze, and became unreadable afterwards, keeps its membership: that
 * chunk stays sealed and refuses to publish, and the chunk beside it publishes normally.
 */

/**
 * The required set is the standing requirement, so it has to shrink as well as grow. A retired
 * statement stops being required; a change to something this chunk never rested on requires
 * nothing at all.
 */

/**
 * What durable state a run leaves behind. A number is spent when it is handed out, so the only
 * question is which rows stay runnable: the one an attempt died before binding, none at all once
 * a publication lands, and a fresh one carrying the reason when an output is refused.
 */

it('takes up its own unpublished allocation and leaves none runnable once one publishes', async () => {
  await accept('session-retry', 'rho2');
  const chunkId = await sealAndPublish('session-retry');

  const failing: ChunkNarrativeDeps = {
    ...chunks,
    provider: {
      embed: () => Promise.reject(new Error('no embedding in this battery')),
      generate: () => Promise.reject(new Error('the provider refused')),
    },
  };
  const failed = await publishChunkNarrative(failing, chunkId, { now: NOW });
  expect(failed.status).toBe('failed');
  const held = listAllocatedRevisions(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(held.map((row) => row.revisionNo)).toEqual(
    failed.status === 'failed' ? [failed.revisionNo] : [],
  );

  const published = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(published.status).toBe('published');
  if (published.status !== 'published' || failed.status !== 'failed') {
    return;
  }
  // The same number, taken up rather than spent beside the first.
  expect(published.revisionNo).toBe(failed.revisionNo);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(published.revisionNo);
  // Nothing is left runnable: a scheduler reading durable state sees no owed work here.
  expect(listAllocatedRevisions(store.db, CHUNK_REVISION_FAMILY, chunkId)).toEqual([]);
  expect(
    nominateRetryableRevisions(store.db, CHUNK_REVISION_FAMILY, NOW, 10).map((r) => r.familyKey),
  ).not.toContain(chunkId);
});

it('leaves a runnable row carrying the reason when the guard refuses the output', async () => {
  const first = await accept('session-refused', 'sigma2');
  const second = await accept('session-refused', 'tau2');
  const chunkId = await sealAndPublish('session-refused');
  expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('published');

  forget(first, 'forget-sigma2');
  // The evidence moves again while the model is being asked, so what comes back describes a
  // substrate that has changed under it.
  whileGenerating(() => {
    forget(second, 'forget-tau2');
  });
  const deferred = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(deferred.status).toBe('deferred');
  if (deferred.status !== 'deferred') {
    return;
  }
  expect(deferred.reason).toContain('evidence_');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);

  // The refused number is spent, and the work is still visible: one runnable row, due now,
  // carrying what refused it for the scheduler that decides how long to wait.
  const owed = listAllocatedRevisions(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(owed.map((row) => row.revisionNo)).toEqual([deferred.revisionNo]);
  const row = readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, deferred.revisionNo);
  expect(row?.lastFailureReason).toBe(deferred.reason);
  expect(row?.attempts).toBe(1);
  expect(row?.nextAttemptAt).toBeNull();
  // Runnable: due now, unblocked, and nominated by the retry read the scheduler pages on.
  expect(
    nominateRetryableRevisions(store.db, CHUNK_REVISION_FAMILY, NOW, 10).map((r) => r.familyKey),
  ).toContain(chunkId);
});

it('never takes up an allocation another attempt has bound to a durable intent', async () => {
  await accept('session-bound', 'upsilon2');
  const chunkId = await sealAndPublish('session-bound');
  scheduleFailure('before_ack');
  await expect(publishChunkNarrative(chunks, chunkId, { now: NOW })).rejects.toThrow();
  const bound = listAllocatedRevisions(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(bound).toHaveLength(1);
  expect(bound[0]?.operationId).not.toBeNull();

  // A second attempt neither steals the bound number nor publishes beside it. It cannot even
  // certify its evidence while a publication is pending, which is the honest refusal: the reading
  // this revision would rest on is one nobody can take a position on yet.
  const next = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(next.status).not.toBe('published');
  if (next.status !== 'skipped') {
    expect(next.revisionNo).not.toBe(bound[0]?.revisionNo);
  }
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();

  // Recovery is what finishes the bound attempt, and it finishes THAT number rather than either
  // of the ones allocated beside it.
  expect((await coordinator.recover())?.status).toBe('acknowledged');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(bound[0]?.revisionNo);
});

/**
 * What a publication owes a later reader: a walk that can cross it, and a moved token wherever a
 * citation population changed. The evicted member is the point of the durable half — the graph
 * fallback is gone and the records are all that is left.
 */

it('lets a durable walk cross the narrative to an evicted member, and invalidates a dropped target', async () => {
  const kept = await accept('session-walk', 'phi2');
  const dropped = await accept('session-walk', 'chi2');
  const chunkId = await sealAndPublish('session-walk');
  const first = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(first.status).toBe('published');
  if (first.status !== 'published') {
    return;
  }

  // A reader fenced on "this target's citation population" as it stood at the first head. The
  // census is what makes an inbound citation population bindable at all, and counting it is the
  // seal's job rather than this publication's: what a revision counts is its own outbound set.
  const key = { endpointId: dropped, relationClass: 'sqlite.revision_citations' };
  establishScope(store.db, dropped, 'sqlite.revision_citations', NOW);
  const held = buildEvidenceRevision([
    {
      kind: 'relation_scope',
      id: dropped,
      scope: 'sqlite.revision_citations',
      version: publishedScopeToken(store.db, key) ?? '',
    },
  ]);
  expect(verifyEvidenceRevision(store.db, held).status).toBe('current');

  // The member is evicted, so nothing but the records can answer for it.
  transitionSourceResidency(store.db, {
    sourceId: kept,
    state: 'evicted',
    operationId: 'evict-phi2',
    transitionedAt: NOW,
  });
  const derived = await accept('session-walk-child', 'psi2');
  prepareStatedLinkVersion(store.db, {
    linkId: statedLinkId('derived_from', 'retained_node', derived, first.nodeId),
    kind: 'derived_from',
    qualifier: 'retained_node',
    fromId: derived,
    toId: first.nodeId,
    operationId: 'derive-from-chunk-narrative',
    operationKey: 'derive-from-chunk-narrative',
    recordedValues: {},
    temporalProof: {},
    observedAt: NOW,
    referenceSourceId: derived,
    referenceVersion: 1,
  });
  acknowledgeStatedLinkVersions(
    store.db,
    'derive-from-chunk-narrative',
    NOW.toISOString(),
    NOW.toISOString(),
  );
  establishScope(store.db, derived, durableRoleScope('stated_derivation', 'out'), NOW);
  const walk = walkLineage(store.db, [derived], undefined);
  expect(walk.roots).toContain(kept);
  expect(walk.complete).toBe(true);

  // The replacement stops citing the dropped member, and the token a reader held moves with it.
  forget(dropped, 'forget-chi2');
  expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('published');
  expect(readCitationsOf(store.db, dropped)).toEqual([]);
  expect(verifyEvidenceRevision(store.db, held).status).toBe('stale');
});
