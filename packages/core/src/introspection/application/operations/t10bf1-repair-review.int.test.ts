import { afterEach, expect, it, vi } from 'vitest';

import { narrativeCleanupOperation } from './narrative-cleanup-operation.js';
import {
  readRelationScope,
  verifyEvidenceRevision,
} from '../../../evidence/application/dependencies.js';
import { GRAPH_NODE_SCOPE } from '../../../evidence/domain/scopes.js';
import {
  commitSourceState,
  establishNodeState,
} from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { supersede, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import * as cleanupQueries from '../../../infrastructure/graph/narrative-cleanup-queries.js';
import {
  countOpenEdgesInto,
  nodeProperties,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { buildEvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
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

afterEach(() => {
  vi.restoreAllMocks();
});

function context(): OperationContext {
  return {
    driver,
    db: store.db,
    config: DEFAULTS,
    provider: chunks.provider,
    logger: chunks.logger,
    narratives: { publications: chunks.publications, resolver: chunks.resolver },
    now: NOW,
    signal: new AbortController().signal,
    health: healthFixture(),
  } as OperationContext;
}

async function family(name: string, revisions = 2): Promise<{ chunkId: string; ids: string[] }> {
  const first = await acceptSource(name, 'first member');
  await acceptSource(name, 'second member');
  const chunkId = await sealFor(first);
  const ids: string[] = [];
  for (let index = 0; index < revisions; index += 1) {
    if (index === 1) {
      forgetSource(first, `forget:${name}`);
    } else if (index > 1) {
      commitSourceState(store.db, {
        sourceId: first,
        stateKind: 'unforgotten',
        operationId: `restore:${name}`,
        at: NOW,
      });
    }
    const result = await publishChunkNarrative(chunks, chunkId, { now: NOW });
    if (result.status !== 'published') {
      throw new Error(`fixture publication did not land: ${result.status}`);
    }
    ids.push(result.nodeId);
  }
  return { chunkId, ids };
}

it('advances the state token for the revision it closes', async () => {
  const held = await family('repair-state-token');
  const old = held.ids[0]!;
  await unsupersedeNode(driver, { id: old, now: NOW });
  establishNodeState(store.db, old, { revision: 1, at: NOW });
  const read = readRelationScope(store.db, {
    kind: 'node',
    endpointId: old,
    scope: GRAPH_NODE_SCOPE,
    empty: false,
  });
  expect(read.status).toBe('verified');
  if (read.status !== 'verified') {
    throw new Error('fixture has no state proof');
  }
  const evidence = buildEvidenceRevision([read.dependency]);
  const result = await narrativeCleanupOperation().run(context());
  expect(result.itemsAffected).toBeGreaterThan(0);
  expect((await nodeProperties(driver, old)).valid_until).toBeDefined();
  expect(verifyEvidenceRevision(store.db, evidence).status).toBe('stale');
});

it('counts the summarization edges closed inside the family publication', async () => {
  const held = await family('repair-edge-accounting');
  const old = held.ids[0]!;
  await unsupersedeNode(driver, { id: old, now: NOW });
  const open = await countOpenEdgesInto(driver, 'SUMMARIZED_BY', old);
  expect(open).toBe(2);
  const result = await narrativeCleanupOperation().run(context());
  expect(await countOpenEdgesInto(driver, 'SUMMARIZED_BY', old)).toBe(0);
  expect(result.itemsAffected).toBe(1 + open);
});

it('does not close every surviving revision onto a head that is not current in the graph', async () => {
  const held = await family('repair-closed-keeper', 3);
  const head = held.ids[2]!;
  for (const id of held.ids.slice(0, 2)) {
    await unsupersedeNode(driver, { id, now: NOW });
  }
  const replacement = 'review-external-head';
  await writeStampedNode(driver, {
    label: 'Insight',
    id: replacement,
    now: NOW,
    properties: { text: 'the external replacement' },
  });
  await supersede(driver, { oldId: head, newId: replacement, now: NOW });
  expect((await nodeProperties(driver, head)).valid_until).toBeDefined();
  await narrativeCleanupOperation().run(context());
  for (const id of held.ids.slice(0, 2)) {
    expect.soft((await nodeProperties(driver, id)).valid_until).toBeUndefined();
  }
});

it('bounds materialized revision records before applying a per-run limit', async () => {
  const held = await family('repair-read-bound', 1);
  for (let index = 0; index < 205; index += 1) {
    await writeStampedNode(driver, {
      label: 'Narrative',
      id: `!unbound-review-${String(index).padStart(3, '0')}`,
      now: NOW,
      properties: { text: 'an unbound version', chunk_id: held.chunkId, narrative_family: 'chunk' },
    });
  }
  const original = cleanupQueries.findDuplicateChunkFamilies;
  let materialized = 0;
  vi.spyOn(cleanupQueries, 'findDuplicateChunkFamilies').mockImplementation(async (...args) => {
    const groups = await original(...args);
    materialized += groups.reduce((count, group) => count + group.versions.length, 0);
    return groups;
  });
  const result = await narrativeCleanupOperation().run(context());
  expect.soft(materialized).toBeLessThanOrEqual(200);
  expect.soft(result.itemsProcessed).toBeLessThanOrEqual(200);
});
