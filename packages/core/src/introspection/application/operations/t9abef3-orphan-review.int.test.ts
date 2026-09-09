import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { orphanSuppressionPublication } from './orphan-suppression.js';
import {
  commitIncidence,
  seedSource,
  establishScope,
  establishNodeState,
  establishNodeSupportScopes,
} from '../../../evidence/test-support/evidence.fixture.js';
import { forgetNode, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  closeEdge,
  nodeProperties,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { relationshipTypesBetween } from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import { clearNodeTxStart } from '../../../infrastructure/graph/test-support/t9abef3-paging.fixture.js';
import {
  findOrphanNodes,
  findOrphanRelinkTargets,
  type OrphanPosition,
} from '../../../infrastructure/graph/topology-queries.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../../infrastructure/publication/handlers.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { readOrphanObservation } from '../../../infrastructure/sqlite/orphan-observations.js';
import {
  recordSupersessionProposal,
  resolveSupersessionProposal,
} from '../../../infrastructure/sqlite/supersession-proposals.js';
import { readOrphanCensus } from '../orphan-census.js';

const EARLY = new Date('2026-01-01T00:00:00.000Z');
const CHECK = new Date('2026-09-01T00:00:00.000Z');
let sub: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-suppression-boundary-'));
  sub = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: sub.sqlitePath });
  await runGraphMigrations(sub.harness.driver, store.db, { embedDimension: 3 });
  coordinator = new PublicationCoordinator({
    driver: sub.harness.driver,
    db: store.db,
    logger: openLogger({ filePath: join(dir, 'test.log'), level: 'fatal' }),
    handlers: [...PUBLICATION_HANDLERS, orphanSuppressionPublication],
  });
  await coordinator.initialize();
}, 120000);
afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(sub);
  rmSync(dir, { recursive: true, force: true });
});

async function unsupported(id: string): Promise<void> {
  await writeStampedNode(sub.harness.driver, {
    label: 'Insight',
    id,
    now: EARLY,
    properties: { text: id },
  });
  establishNodeSupportScopes(store.db, id, EARLY);
  establishNodeState(store.db, id, { revision: 1, at: EARLY });
  await readOrphanCensus(
    { driver: sub.harness.driver, db: store.db },
    { limit: 100, now: EARLY, forgetAfterDays: 30, policyRevision: 0 },
  );
}

it('resets qualification after a proposal opens and closes between observations', async () => {
  const id = 'proposal-history';
  await unsupported(id);
  const proposal = recordSupersessionProposal(store.db, {
    oldId: id,
    newId: 'other-proposal-node',
    confidence: 0.9,
    episodeId: 'source',
    createdAt: '2026-08-30T00:00:00.000Z',
  });
  expect(resolveSupersessionProposal(store.db, proposal, '2026-08-31T00:00:00.000Z')).toBe(true);
  await readOrphanCensus(
    { driver: sub.harness.driver, db: store.db },
    { limit: 100, now: CHECK, forgetAfterDays: 30, policyRevision: 0 },
  );
  expect.soft(readOrphanObservation(store.db, id)?.firstVerifiedAt).toBe(CHECK.toISOString());
  const result = await coordinator.publish({
    kind: 'topology_update',
    operationId: 'proposal-history-suppress',
    payload: { nodeId: id, policyRevision: 0, forgetBefore: '2026-08-01T00:00:00.000Z' },
  });
  expect.soft(result.status).toBe('deferred');
  expect((await nodeProperties(sub.harness.driver, id)).forgotten_at).toBeUndefined();
});

it('resets qualification after an association opens and closes between observations', async () => {
  const id = 'association-history';
  await unsupported(id);
  await writeStampedNode(sub.harness.driver, {
    label: 'Insight',
    id: 'association-peer',
    now: EARLY,
    properties: { text: 'peer' },
  });
  await upsertEdge(sub.harness.driver, {
    type: 'RELATED_TO',
    sourceId: id,
    targetId: 'association-peer',
    strength: 0.5,
    confidence: 1,
    signals: [],
    provenance: ['fixture'],
    count: 0,
    now: new Date('2026-08-30T00:00:00.000Z'),
  });
  await closeEdge(
    sub.harness.driver,
    'RELATED_TO',
    id,
    'association-peer',
    new Date('2026-08-31T00:00:00.000Z'),
  );
  await readOrphanCensus(
    { driver: sub.harness.driver, db: store.db },
    { limit: 100, now: CHECK, forgetAfterDays: 30, policyRevision: 0 },
  );
  expect.soft(readOrphanObservation(store.db, id)?.firstVerifiedAt).toBe(CHECK.toISOString());
  const result = await coordinator.publish({
    kind: 'topology_update',
    operationId: 'association-history-suppress',
    payload: { nodeId: id, policyRevision: 0, forgetBefore: '2026-08-01T00:00:00.000Z' },
  });
  expect.soft(result.status).toBe('deferred');
  expect((await nodeProperties(sub.harness.driver, id)).forgotten_at).toBeUndefined();
});

it.each([false, true])(
  'checks retained-target currency at the guarded relink boundary, forgotten=%s',
  async (forgotten) => {
    const prefix = forgotten ? 'retired' : 'current';
    const orphanId = `${prefix}-orphan`;
    const targetId = `${prefix}-target`;
    const sourceId = `${prefix}-source`;
    seedSource(store.db, {
      sourceId,
      sessionId: prefix,
      identity: prefix,
      content: { observations: ['shared evidence'] },
      now: EARLY,
    });
    establishScope(store.db, sourceId, 'source.state', EARLY);
    await writeStampedNode(sub.harness.driver, {
      label: 'Episode',
      id: sourceId,
      now: EARLY,
      properties: { text: 'raw source' },
    });
    for (const id of [orphanId, targetId]) {
      await writeStampedNode(sub.harness.driver, {
        label: 'Insight',
        id,
        now: EARLY,
        properties: { text: id },
      });
      establishNodeState(store.db, id, { revision: 1, at: EARLY });
      commitIncidence(store.db, {
        sourceId,
        nodeId: id,
        role: 'extraction',
        operationId: `incidence-${id}`,
        at: EARLY,
      });
      await upsertEdge(sub.harness.driver, {
        type: 'EXTRACTED_FROM',
        sourceId: id,
        targetId: sourceId,
        strength: 1,
        confidence: 1,
        signals: [],
        provenance: ['fixture'],
        count: 0,
        now: EARLY,
      });
    }
    const nomination = (await findOrphanRelinkTargets(sub.harness.driver, [orphanId]))[0];
    expect(nomination?.targetId).toBe(targetId);
    if (forgotten) {
      await forgetNode(sub.harness.driver, { id: targetId, now: CHECK });
      establishNodeState(store.db, targetId, { revision: 2, at: CHECK });
    }
    const result = await coordinator.publish({
      kind: 'topology_update',
      operationId: `repair-${prefix}`,
      payload: { mode: 'relink', orphanId, targetId, relinkKind: 'same_container' },
    });
    expect.soft(result.status).toBe(forgotten ? 'deferred' : 'acknowledged');
    const edges = await relationshipTypesBetween(sub.harness.driver, orphanId, targetId);
    expect(edges.includes('RELATED_TO')).toBe(!forgotten);
  },
);

it('pages the graph order with fixed bounds including null dates', async () => {
  for (let i = 0; i < 12; i += 1) {
    await writeStampedNode(sub.harness.driver, {
      label: 'Insight',
      id: `paging-${i}`,
      now: EARLY,
      properties: { text: 'page' },
    });
    if (i % 3 === 0) {
      await clearNodeTxStart(sub.harness.driver, `paging-${i}`);
    }
  }
  const expected = (await findOrphanNodes(sub.harness.driver, 100)).map((x) => x.id);
  const found: string[] = [];
  let after: OrphanPosition | undefined;
  for (let page = 0; page < 100; page += 1) {
    const rows = await findOrphanNodes(sub.harness.driver, 3, after);
    expect(rows.length).toBeLessThanOrEqual(3);
    found.push(...rows.map((x) => x.id));
    const last = rows.at(-1);
    if (last === undefined || rows.length < 3) {
      break;
    }
    after = { id: last.id, txFrom: last.txFrom };
  }
  expect(found).toEqual(expected);
  expect(new Set(found).size).toBe(found.length);
});
