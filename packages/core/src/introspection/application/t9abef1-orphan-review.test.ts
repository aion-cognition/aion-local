import type { Driver } from 'neo4j-driver';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readOrphanCensus } from './orphan-census.js';
import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import {
  seedSource,
  establishNodeState,
  establishNodeSupportScopes,
} from '../../evidence/test-support/evidence.fixture.js';
import * as topology from '../../infrastructure/graph/topology-queries.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { listStatedLinks } from '../../infrastructure/sqlite/evidence-links.js';
import { readOrphanObservation } from '../../infrastructure/sqlite/orphan-observations.js';
import {
  preparePublicationIntent,
  acknowledgePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import {
  prepareReferenceAcceptance,
  acknowledgeReferenceAcceptance,
} from '../../reflection/application/reference-acceptance.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');
const LATER = new Date('2026-09-08T00:00:00.000Z');
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

it('eventually nominates beyond the fixed oldest window', async () => {
  const all = Array.from({ length: 11 }, (_, index) => ({
    id: `node-${String(index)}`,
    txFrom: NOW,
  }));
  // The keyset the production query carries, honoured here in the query's own order: every page
  // is the same bounded read and the position is what moves it. A stub that ignored the position
  // could only reach a later node by fetching a longer prefix, which is the read bound this walk
  // exists to hold.
  const ordered = [...all].sort((left, right) => (left.id < right.id ? -1 : 1));
  vi.mocked(topology.findOrphanNodes).mockImplementation(async (_driver, limit, after) =>
    ordered.filter((node) => after === undefined || node.id > after.id).slice(0, limit),
  );
  vi.mocked(topology.findOrphanRelinkTargets).mockResolvedValue([]);
  const examined = new Set<string>();
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const read = await readOrphanCensus(
      { driver, db: store.db },
      {
        limit: 1,
        now: new Date(NOW.getTime() + attempt * 1000),
        forgetAfterDays: 30,
        policyRevision: 1,
      },
    );
    read.entries.forEach((entry) => examined.add(entry.nodeId));
  }
  expect(examined.has('node-10')).toBe(true);
});

it('restarts maturity when node semantic scope changes between observations', async () => {
  establishNodeState(store.db, 'node', { revision: 1, at: NOW });
  await census();
  establishNodeState(store.db, 'node', { revision: 2, at: LATER });
  const read = await census(LATER);
  expect.soft(read.entries[0]?.decision.action).toBe('hold');
  expect(readOrphanObservation(store.db, 'node')?.firstVerifiedAt).toBe(LATER.toISOString());
});

it('keeps an unavailable node proof from establishing an orphan qualification', async () => {
  await census();
  expect(readOrphanObservation(store.db, 'node')?.disposition).not.toBe('unsupported');
});

it('does not write a relink from an uncertified target hint after support alone was counted', async () => {
  vi.mocked(topology.findOrphanRelinkTargets).mockResolvedValue([
    { orphanId: 'node', targetId: 'unproved', kind: 'same_container' },
  ]);
  expect((await census()).entries[0]?.decision.action).toBe('hold');
});

it('does not call a confirmation from the actual acceptance writer absent support', () => {
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'identity',
    now: NOW,
    content: { observations: ['a recorded confirmation'] },
  });
  const acceptance = {
    sourceId: 'source',
    operationId: 'confirmed',
    acceptedAt: NOW.toISOString(),
    deliveryKey: 'confirmation-delivery',
    targets: [
      {
        id: 'node',
        kind: 'confirms' as const,
        targetClass: 'retained_node' as const,
        confirmation: { by: 'user', evidence: 'confirmed directly', occurredAt: NOW.toISOString() },
      },
    ],
  };
  preparePublicationIntent(store.db, {
    operationId: 'confirmed',
    kind: 'stated_references',
    payloadDigest: 'd',
    payloadJson: '{}',
    expectedJson: '{}',
    affectedScopesJson: '[]',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
  const referenceVersion = prepareReferenceAcceptance(store.db, acceptance);
  acknowledgeReferenceAcceptance(store.db, {
    ...acceptance,
    referenceVersion,
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
  });
  acknowledgePublicationIntent(store.db, {
    operationId: 'confirmed',
    resultDigest: 'd',
    resultJson: '{}',
    observedAckAt: NOW,
  });
  expect(listStatedLinks(store.db, 'source')).toHaveLength(1);
  expect(certifyNodeSupport(store.db, 'node').support).not.toBe('unsupported');
});
