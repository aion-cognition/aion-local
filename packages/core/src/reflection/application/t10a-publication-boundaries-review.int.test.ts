import { expect, it } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import {
  acceptSource,
  activateCoverage,
  chunks,
  driver,
  dropCensus,
  forgetSource,
  NOW,
  onGenerate,
  prompts,
  sealFor,
  store,
} from './test-support/t10a-review.fixture.js';
import { walkLineage } from '../../evidence/application/lineage-walk.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { EVIDENCE_LIMITS } from '../../evidence/domain/budget.js';
import { establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import {
  prepareStatedLinkVersion,
  acknowledgeStatedLinkVersions,
  statedLinkId,
} from '../../infrastructure/sqlite/evidence-links.js';
import { publishedScopeToken } from '../../infrastructure/sqlite/evidence-scope.js';
import {
  readCitationsFrom,
  readCitationsOf,
} from '../../infrastructure/sqlite/narrative-citations.js';
import {
  CHUNK_REVISION_FAMILY,
  readNarrativeRevision,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';

it('does not publish while the incoming correction population is unproved', async () => {
  const source = await acceptSource('uncounted', 'uncounted source', false);
  dropCensus(source);
  const chunk = await sealFor(source);
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(result.status).not.toBe('published');
});

it('holds the coverage epoch from evidence assembly through publication', async () => {
  const source = await acceptSource('coverage-race', 'coverage source');
  const chunk = await sealFor(source);
  const priorEpoch = readCurrentCoverageContract(store.db)!.epoch;
  onGenerate(async () => {
    await activateCoverage();
  });
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(prompts).toHaveLength(1);
  expect(readCurrentCoverageContract(store.db)!.epoch).not.toBe(priorEpoch);
  expect(result.status).not.toBe('published');
});

it('fences every source re-read in its own request allowance', async () => {
  await acceptSource('bounded-sources', 'first bounded source');
  const second = await acceptSource('bounded-sources', 'second bounded source');
  const chunk = await sealFor(second);
  const limited = {
    ...chunks,
    resolver: new EvidenceResolver({
      driver,
      db: store.db,
      logger: chunks.logger,
      publications: chunks.publications,
      limits: { ...EVIDENCE_LIMITS, requestedIds: 1 },
    }),
  };
  onGenerate(() => {
    forgetSource(second, 'forget-during-generation');
  });
  const result = await publishChunkNarrative(limited, chunk, { now: NOW });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('second bounded source');
  expect(result.status).not.toBe('published');
});

it('reuses an unpublished allocation after a synthesis failure', async () => {
  const source = await acceptSource('retry-allocation', 'retry source');
  const chunk = await sealFor(source);
  onGenerate(() => {
    throw new Error('provider refused');
  });
  const first = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(first.status).toBe('failed');
  onGenerate(() => undefined);
  const second = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(second.status).toBe('published');
  if (first.status === 'skipped' || second.status !== 'published') {
    throw new Error('unexpected fixture outcome');
  }
  expect.soft(second.revisionNo).toBe(first.revisionNo);
  expect
    .soft(readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunk, first.revisionNo)?.state)
    .not.toBe('allocated');
});

it('publishes the scope needed to walk the new narrative citations', async () => {
  const source = await acceptSource('citation-walk', 'citation source');
  const chunk = await sealFor(source);
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(result.status).toBe('published');
  if (result.status !== 'published') {
    throw new Error('publication failed');
  }
  expect(readCitationsFrom(store.db, result.nodeId).map((row) => row.targetId)).toContain(source);
  const checked = checkPresentCoverage(store.db, NOW);
  if (checked.status !== 'checked') {
    throw new Error('coverage refused');
  }
  const evidence = await chunks.resolver.resolveMetadata([result.nodeId], checked.context, {
    maxRoots: 3,
  });
  const reading = [...evidence.results.values()][0];
  // The graph fallback can still name a source while the durable parent walk cannot cross the
  // new narrative. An explicit parent exercises the durable contract required after eviction.
  expect(reading?.value?.provenance.roots).toContain(source);
  const derived = await acceptSource(
    'citation-child',
    'a later experience derived from the narrative',
  );
  prepareStatedLinkVersion(store.db, {
    linkId: statedLinkId('derived_from', 'retained_node', derived, result.nodeId),
    kind: 'derived_from',
    qualifier: 'retained_node',
    fromId: derived,
    toId: result.nodeId,
    operationId: 'derive-from-narrative',
    operationKey: 'derive-from-narrative',
    recordedValues: {},
    temporalProof: {},
    observedAt: NOW,
    referenceSourceId: derived,
    referenceVersion: 1,
  });
  acknowledgeStatedLinkVersions(
    store.db,
    'derive-from-narrative',
    NOW.toISOString(),
    NOW.toISOString(),
  );
  establishScope(store.db, derived, 'sqlite:stated_derivation:out', NOW);
  const walk = walkLineage(store.db, [derived], undefined);
  expect.soft(walk.roots).toContain(source);
  expect.soft(walk.complete).toBe(true);
});

it('advances a targets citation scope when a replacement stops citing it', async () => {
  const first = await acceptSource('citation-close', 'earlier citation source');
  await acceptSource('citation-close', 'retained citation source');
  const chunk = await sealFor(first);
  const initial = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(initial.status).toBe('published');
  expect(readCitationsOf(store.db, first).length).toBe(1);
  const key = { endpointId: first, relationClass: 'sqlite.revision_citations' };
  const before = publishedScopeToken(store.db, key);
  forgetSource(first, 'forgotten-citation-source');
  const replacement = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(replacement.status).toBe('published');
  expect(readCitationsOf(store.db, first)).toEqual([]);
  expect(publishedScopeToken(store.db, key)).not.toBe(before);
});

it('control: a complete head without changed dependencies costs no second generation', async () => {
  const source = await acceptSource('healthy-control', 'complete source');
  const chunk = await sealFor(source);
  const first = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(first.status).toBe('published');
  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunk);
  const second = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(second).toMatchObject({ status: 'skipped', reason: 'head_current' });
  expect(prompts).toHaveLength(1);
  expect(readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunk)).toEqual(head);
});
