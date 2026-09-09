import type { Driver } from 'neo4j-driver';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readOrphanCensus } from './orphan-census.js';
import {
  establishScope,
  seedSource,
  commitIncidence,
  establishNodeState,
  establishNodeSupportScopes,
} from '../../evidence/test-support/evidence.fixture.js';
import * as topology from '../../infrastructure/graph/topology-queries.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');
const driver = {} as Driver;
let store: SqliteStore;
let nodes: topology.OrphanNode[];
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  nodes = [{ id: 'node', txFrom: NOW }];
  vi.spyOn(topology, 'findOrphanNodes').mockImplementation(async () => nodes);
  vi.spyOn(topology, 'findOrphanRelinkTargets').mockResolvedValue([]);
  // The graph this fixture models holds loose nodes and no association at all, ever; the census
  // now asks for that history rather than inferring it from the absence of an open edge.
  vi.spyOn(topology, 'nodeAssociationHistory').mockImplementation(
    async (_driver, ids) => new Map(ids.map((id) => [id, topology.NO_ASSOCIATION_HISTORY])),
  );
  establishNodeSupportScopes(store.db, 'node', NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});
function census(now = NOW) {
  return readOrphanCensus(
    { driver, db: store.db },
    { limit: 10, now, forgetAfterDays: 30, policyRevision: 1 },
  );
}

it('bounds each graph read rather than growing the fetched prefix on every window', async () => {
  const all = Array.from({ length: 100 }, (_, i) => ({ id: `node-${String(i)}`, txFrom: NOW }));
  const limits: number[] = [];
  vi.mocked(topology.findOrphanNodes).mockImplementation(async (_driver, limit) => {
    limits.push(limit);
    return all.slice(0, limit);
  });
  for (let i = 0; i < 5; i += 1) {
    await readOrphanCensus(
      { driver, db: store.db },
      { limit: 1, now: NOW, forgetAfterDays: 30, policyRevision: 1 },
    );
  }
  expect(Math.max(...limits)).toBeLessThanOrEqual(10);
});
it('does not certify a present relink from closed incidence alone', async () => {
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { observations: ['shared evidence'] },
    now: NOW,
  });
  establishScope(store.db, 'source', 'source.state', NOW);
  establishNodeState(store.db, 'target', { revision: 1, at: NOW });
  establishNodeState(store.db, 'node', { revision: 1, at: NOW });
  for (const [nodeId, operationId] of [
    ['node', 'old-orphan'],
    ['target', 'old-target'],
  ]) {
    commitIncidence(store.db, {
      sourceId: 'source',
      nodeId: nodeId!,
      role: 'extraction',
      operationId: operationId!,
      at: NOW,
      currency: 'closed',
    });
  }
  vi.mocked(topology.findOrphanRelinkTargets).mockResolvedValue([
    { orphanId: 'node', targetId: 'target', kind: 'same_container' },
  ]);
  expect((await census()).entries[0]?.decision.action).toBe('hold');
});

it('keeps the current shared-source relink control eligible', async () => {
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { observations: ['shared evidence'] },
    now: NOW,
  });
  establishScope(store.db, 'source', 'source.state', NOW);
  establishNodeState(store.db, 'target', { revision: 1, at: NOW });
  establishNodeState(store.db, 'node', { revision: 1, at: NOW });
  for (const [nodeId, operationId] of [
    ['node', 'old-orphan'],
    ['target', 'old-target'],
  ]) {
    commitIncidence(store.db, {
      sourceId: 'source',
      nodeId: nodeId!,
      role: 'extraction',
      operationId: operationId!,
      at: NOW,
      currency: 'open',
    });
  }
  vi.mocked(topology.findOrphanRelinkTargets).mockResolvedValue([
    { orphanId: 'node', targetId: 'target', kind: 'same_container' },
  ]);
  expect((await census()).entries[0]?.decision.action).toBe('relink');
});
