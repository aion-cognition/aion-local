import { expect, it, vi } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import { familyCutoverPublication } from './family-cutover.js';
import { readFamilyFence } from './family-fence.js';
import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import {
  cutoverSessionFamily,
  ensureSessionFamily,
  inventoryLegacyNarrative,
} from './narrative-family.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import {
  readNarrativeRepresentations,
  revalidateNarrativeRepresentations,
} from '../../evidence/application/narrative-representation.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { evidenceRequestKey, idAddress } from '../../evidence/domain/address.js';
import { RequestBudget } from '../../evidence/domain/budget.js';
import { checkedContext } from '../../evidence/test-support/evidence.fixture.js';
import {
  legacyFamilySnapshot,
  seedLegacyFamilyVersion,
} from '../../infrastructure/graph/test-support/family-cutover.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readFamilySelection } from '../../infrastructure/sqlite/family-selection.js';
import { readLegacyNarrative } from '../../infrastructure/sqlite/legacy-narratives.js';
import { recordMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import { rememberMigrationPolicy } from '../../infrastructure/sqlite/migration-partition.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

it('selects representation by knowledge time and retires with the canonical acknowledgment', async () => {
  const sourceId = await acceptSource('family-temporal', 'historical source', false);
  const sessionId = sessionOf(sourceId);
  const legacyId = 'legacy-family-temporal';
  await seedLegacyFamilyVersion(driver, {
    nodeId: legacyId,
    sessionId,
    sources: [sourceId],
    now: NOW,
  });
  const clock = vi.fn(() => new Date(NOW.getTime() + 1000));
  const publications = new PublicationCoordinator({
    driver,
    db: store.db,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    logger: { warn: () => undefined, error: () => undefined },
    now: () => clock(),
  });
  await publications.initialize();
  const deps = { ...chunks, publications };
  expect((await ensureSessionFamily(deps, sessionId)).status).toBe('ready');
  expect(readFamilySelection(store.db, sessionId)?.family).toBe('legacy_session_overview');
  const cohortId = 'family-temporal';
  await freezeLegacyCohort(deps, { cohortId, now: clock() });
  rememberMigrationPolicy(store.db, cohortId, {
    ...CHUNK_BOUNDARY_POLICY,
    partitionPolicyVersion: 1,
  });
  expect(await runLegacyBackfillBatch(deps, { cohortId, now: clock() })).toMatchObject({
    remaining: 0,
    pinned: 0,
  });
  expect((await sealLegacyCohortCensus(deps, { cohortId })).deferred).toBeUndefined();
  expect((await inventoryLegacyNarrative(deps, { sessionId, narrativeId: legacyId })).status).toBe(
    'acknowledged',
  );
  expect(readLegacyNarrative(store.db, legacyId)?.verificationStatus).toBe('verified');
  const sealed = sealChunk(store.db, { sessionId, sourceIds: [sourceId], sealedAt: clock() });
  recordMigrationProgress(store.db, {
    cohortId,
    sourceId,
    status: 'verified',
    partitionAssignment: sealed.chunkId,
  });
  expect((await cutoverSessionFamily(deps, { sessionId, cohortId })).status).toBe('deferred');
  clock.mockReturnValue(new Date(NOW.getTime() + 2000));
  const chunk = await publishChunkNarrative(deps, sealed.chunkId, { now: clock() });
  expect(chunk.status).toBe('published');
  if (chunk.status !== 'published') {
    throw new Error('fixture chunk did not publish');
  }
  const beforeK = new Date(NOW.getTime() + 3000);
  const before = readFamilyFence(store.db, sessionId)!;
  const original = await legacyFamilySnapshot(driver, legacyId);
  const heldPolicies = await readNarrativeRepresentations(
    { driver, db: store.db },
    [legacyId, chunk.nodeId],
    checkedContext({ now: clock() }),
    new RequestBudget(),
  );
  expect(heldPolicies.values.get(legacyId)?.selection).toBe('selected');
  expect(heldPolicies.values.get(chunk.nodeId)?.selection).toBe('not_selected');
  clock.mockReturnValue(new Date(NOW.getTime() + 4000));
  const refused = vi
    .spyOn(familyCutoverPublication, 'check')
    .mockResolvedValueOnce({ status: 'deferred', reason: 'test_precondition_moved' });
  expect((await cutoverSessionFamily(deps, { sessionId, cohortId })).status).toBe('deferred');
  refused.mockRestore();
  expect((await cutoverSessionFamily(deps, { sessionId, cohortId })).status).toBe('acknowledged');
  expect(readLegacyNarrative(store.db, legacyId)?.retiredAt).toBe(clock().toISOString());
  const changes = store.db.prepare('SELECT total_changes() AS count').get();
  store.db.pragma('query_only = ON');
  try {
    const reread = revalidateNarrativeRepresentations(
      store.db,
      heldPolicies.values,
      checkedContext({ now: clock() }),
    );
    expect(reread.values.get(legacyId)?.selection).toBe('not_selected');
    expect(reread.values.get(chunk.nodeId)).toMatchObject({
      selection: 'selected',
      publication: 'established',
    });
    expect(store.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
  } finally {
    store.db.pragma('query_only = OFF');
  }
  expect(verifyEvidenceRevision(store.db, buildEvidenceRevision([before.dependency])).status).toBe(
    'stale',
  );
  const retired = await legacyFamilySnapshot(driver, legacyId);
  const afterProps = { ...(retired.properties as Record<string, unknown>) };
  expect(afterProps.representation_retired_by).toBeTypeOf('string');
  delete afterProps.representation_retired_by;
  expect(afterProps).toEqual(original.properties);
  expect(retired.supersession_edges).toBe(0);
  for (const [mode, legacySelected] of [
    [{}, false],
    [{ knownAt: beforeK }, true],
    [{ validAt: new Date(NOW.getTime() - 60_000) }, false],
    [{ validAt: new Date(NOW.getTime() - 60_000), knownAt: beforeK }, true],
  ] as const) {
    const view = await readNarrativeRepresentations(
      { driver, db: store.db },
      [legacyId, chunk.nodeId],
      checkedContext({ mode, now: clock() }),
      new RequestBudget(),
    );
    expect(view.issues).toEqual([]);
    expect(view.values.get(legacyId)?.selection).toBe(legacySelected ? 'selected' : 'not_selected');
    expect(view.values.get(chunk.nodeId)?.selection).toBe(
      legacySelected ? 'not_selected' : 'selected',
    );
    if (legacySelected) {
      expect(view.values.get(legacyId)?.retired).toBeUndefined();
    }
  }
  expect((await cutoverSessionFamily(deps, { sessionId, cohortId })).status).toBe(
    'already_selected',
  );
});

it('keeps a committed marker uncertified until recovery acknowledges the same cutover', async () => {
  const sourceId = await acceptSource(
    'family-crash',
    'source survives the interrupted retirement',
    false,
  );
  const sessionId = sessionOf(sourceId);
  const legacyId = 'legacy-family-crash';
  await seedLegacyFamilyVersion(driver, {
    nodeId: legacyId,
    sessionId,
    sources: [sourceId],
    now: NOW,
  });
  const clock = vi.fn(() => new Date(NOW.getTime() + 10_000));
  let interrupt = false;
  const logger = { warn: () => undefined, error: () => undefined };
  const publications = new PublicationCoordinator({
    driver,
    db: store.db,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    logger,
    now: () => clock(),
    boundary: ({ boundary, operationId }) => {
      if (interrupt && boundary === 'before_ack' && operationId.startsWith('family-cutover:')) {
        interrupt = false;
        throw new Error('cutover interrupted after graph commit');
      }
    },
  });
  await publications.initialize();
  const deps = { ...chunks, publications };
  expect((await ensureSessionFamily(deps, sessionId)).status).toBe('ready');
  const cohortId = 'family-crash';
  await freezeLegacyCohort(deps, { cohortId, now: clock() });
  rememberMigrationPolicy(store.db, cohortId, {
    ...CHUNK_BOUNDARY_POLICY,
    partitionPolicyVersion: 1,
  });
  expect(await runLegacyBackfillBatch(deps, { cohortId, now: clock() })).toMatchObject({
    remaining: 0,
    pinned: 0,
  });
  expect((await sealLegacyCohortCensus(deps, { cohortId })).deferred).toBeUndefined();
  const sealed = sealChunk(store.db, { sessionId, sourceIds: [sourceId], sealedAt: clock() });
  recordMigrationProgress(store.db, {
    cohortId,
    sourceId,
    status: 'verified',
    partitionAssignment: sealed.chunkId,
  });
  clock.mockReturnValue(new Date(NOW.getTime() + 11_000));
  expect((await publishChunkNarrative(deps, sealed.chunkId, { now: clock() })).status).toBe(
    'published',
  );
  clock.mockReturnValue(new Date(NOW.getTime() + 12_000));
  interrupt = true;
  await expect(cutoverSessionFamily(deps, { sessionId, cohortId })).rejects.toThrow();
  expect(publications.hasPending()).toBe(true);
  expect(readFamilySelection(store.db, sessionId)?.family).toBe('legacy_session_overview');
  expect(readLegacyNarrative(store.db, legacyId)?.retiredAt ?? null).toBeNull();
  const resolver = new EvidenceResolver({ driver, db: store.db, publications, logger });
  const reading = await resolver.resolveMetadata([legacyId], checkedContext({ now: clock() }), {
    maxRoots: 16,
  });
  expect(reading.issues.some((issue) => issue.reason === 'pending_publication')).toBe(true);
  expect(
    reading.results.get(evidenceRequestKey(idAddress(legacyId)))?.value?.representation?.selection,
  ).toBe('selected');

  const reopened = new SqliteStore({ filePath: store.db.name });
  try {
    clock.mockReturnValue(new Date(NOW.getTime() + 13_000));
    const recovery = new PublicationCoordinator({
      driver,
      db: reopened.db,
      handlers: [...INSTALLED_PUBLICATION_HANDLERS],
      logger,
      now: () => clock(),
    });
    await recovery.initialize();
    expect((await recovery.recover())?.status).toBe('acknowledged');
    expect(recovery.hasPending()).toBe(false);
    expect(readFamilySelection(reopened.db, sessionId)?.family).toBe('chunk');
    expect(readLegacyNarrative(reopened.db, legacyId)?.retiredAt).toBe(clock().toISOString());
    expect(await recovery.recover()).toBeUndefined();
  } finally {
    reopened.close();
  }
});
