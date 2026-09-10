import { expect, it } from 'vitest';

import { narrativeCleanupOperation } from './narrative-cleanup-operation.js';
import { commitSourceState } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { coordinatorControl } from '../../../infrastructure/sqlite/publication-coordinator-store.js';
import { publishChunkNarrative } from '../../../reflection/application/chunk-narrative.js';
import {
  acceptSource,
  chunks,
  driver,
  forgetSource,
  NOW,
  sealFor,
  store,
} from '../../../reflection/application/test-support/t10b-review.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

function context(): OperationContext {
  return {
    driver,
    db: store.db,
    config: { ...DEFAULTS, maintenance: { ...DEFAULTS.maintenance, narrativeCleanupBatch: 1 } },
    provider: chunks.provider,
    logger: chunks.logger,
    narratives: { publications: chunks.publications, resolver: chunks.resolver },
    now: NOW,
    signal: new AbortController().signal,
    health: healthFixture(),
  } as OperationContext;
}

async function twoRevisions(
  session: string,
): Promise<{ chunkId: string; first: string; second: string; source: string }> {
  const source = await acceptSource(session, 'one member');
  await acceptSource(session, 'another member');
  const chunkId = await sealFor(source);
  const first = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(first.status).toBe('published');
  forgetSource(source, `forget-${session}`);
  const second = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  if (first.status !== 'published' || second.status !== 'published') {
    throw new Error('the fixture requires two acknowledged heads');
  }
  return { chunkId, first: first.nodeId, second: second.nodeId, source };
}

it('acknowledges semantic duplicate cleanup through the shared publication boundary', async () => {
  const family = await twoRevisions('cleanup-publication');
  await unsupersedeNode(driver, { id: family.first, now: NOW });
  const before = coordinatorControl(store.db).lastAckSequence;
  const result = await narrativeCleanupOperation().run(context());
  expect(result.itemsAffected).toBeGreaterThan(0);
  expect((await nodeProperties(driver, family.first)).valid_until).toBeDefined();
  expect(BigInt(coordinatorControl(store.db).lastAckSequence)).toBeGreaterThan(BigInt(before));
});

it('counts examined revision records in the same units as affected revision records', async () => {
  const family = await twoRevisions('cleanup-counts');
  commitSourceState(store.db, {
    sourceId: family.source,
    stateKind: 'unforgotten',
    operationId: 'cleanup-counts-restore',
    at: NOW,
  });
  const third = await publishChunkNarrative(chunks, family.chunkId, { now: NOW });
  expect(third.status).toBe('published');
  await unsupersedeNode(driver, { id: family.first, now: NOW });
  await unsupersedeNode(driver, { id: family.second, now: NOW });
  const result = await narrativeCleanupOperation().run(context());
  expect(result.itemsAffected).toBeGreaterThanOrEqual(2);
  expect(result.itemsProcessed).toBeGreaterThanOrEqual(result.itemsAffected);
});
