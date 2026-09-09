import type { Driver } from 'neo4j-driver';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { resolvePendingMeasures } from './operation-scoring.js';
import { orphanCleanupOperation } from './operations/orphan-cleanup.js';
import { readOrphanCensus } from './orphan-census.js';
import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import {
  commitIncidence,
  establishNodeState,
  establishNodeSupportScopes,
} from '../../evidence/test-support/evidence.fixture.js';
import * as topology from '../../infrastructure/graph/topology-queries.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import * as proposals from '../../infrastructure/sqlite/entity-merge-proposals.js';
import {
  setPendingMeasure,
  operationStats,
} from '../../infrastructure/sqlite/introspection-counters.js';
import {
  readOrphanObservation,
  recordOrphanQualification,
} from '../../infrastructure/sqlite/orphan-observations.js';
import { decideOrphan } from '../domain/orphan-policy.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

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
  establishNodeState(store.db, 'node', { revision: 1, at: NOW });
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

it('does not relink from uncounted support and an unproved target hint', () => {
  expect(
    decideOrphan(
      {
        nodeId: 'node',
        support: 'unknown',
        relinkTarget: 'hint',
        protectedByPendingWork: false,
        qualifiedSince: undefined,
      },
      { now: NOW, forgetAfterDays: 30 },
    ).action,
  ).toBe('hold');
});

it('starts orphan maturity only after pending judgment protection is gone', async () => {
  const pending = vi
    .spyOn(proposals, 'findEntityMergeProposalsForNode')
    .mockReturnValue([{ resolvedAt: null }] as ReturnType<
      typeof proposals.findEntityMergeProposalsForNode
    >);
  expect((await census()).entries[0]?.decision.action).toBe('hold');
  pending.mockReturnValue([]);
  const read = await census(LATER);
  expect.soft(read.entries[0]?.decision.action).toBe('hold');
  expect.soft(readOrphanObservation(store.db, 'node')?.firstVerifiedAt).toBe(LATER.toISOString());
});

it('does not carry orphan age across an observed departure from the disconnected population', async () => {
  await census();
  nodes = [];
  await census(new Date('2026-08-15T00:00:00.000Z'));
  nodes = [{ id: 'node', txFrom: NOW }];
  const read = await census(LATER);
  expect.soft(read.entries[0]?.decision.action).toBe('hold');
  expect.soft(readOrphanObservation(store.db, 'node')?.firstVerifiedAt).toBe(LATER.toISOString());
});

it('resets qualification when the policy revision changes', () => {
  recordOrphanQualification(store.db, {
    nodeId: 'node',
    evidenceRevision: { scope: '1' },
    policyRevision: 1,
    disposition: 'unsupported',
    reason: 'empty',
    now: NOW,
  });
  expect(
    recordOrphanQualification(store.db, {
      nodeId: 'node',
      evidenceRevision: { scope: '1' },
      policyRevision: 2,
      disposition: 'unsupported',
      reason: 'empty',
      now: LATER,
    }).firstVerifiedAt,
  ).toBe(LATER.toISOString());
});

it('does not classify an acknowledged confirmation as absent support', () => {
  commitIncidence(store.db, {
    sourceId: 'source',
    nodeId: 'node',
    role: 'stated_confirmation',
    operationId: 'confirm',
    at: NOW,
  });
  expect(certifyNodeSupport(store.db, 'node').support).not.toBe('unsupported');
});

it('keeps the unchanged empty-support qualification control stable', async () => {
  await census();
  const read = await census(LATER);
  expect(read.entries[0]?.decision.action).toBe('forget');
  expect(readOrphanObservation(store.db, 'node')?.firstVerifiedAt).toBe(NOW.toISOString());
});

it('invalidates the pending old-ratio sample when orphan cleanup becomes unmeasured', () => {
  setPendingMeasure(store.db, 'orphan_cleanup', 0.9);
  const logger = openLogger({ filePath: '/dev/null', level: 'error' });
  resolvePendingMeasures({ db: store.db, logger }, [orphanCleanupOperation()], healthFixture());
  expect(operationStats(store.db, 'orphan_cleanup').pendingMeasure).toBeUndefined();
});
