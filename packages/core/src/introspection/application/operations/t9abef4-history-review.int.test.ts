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
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
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
import {
  findOrphanRelinkTargets,
  findOrphanNodes,
  nodeAssociationHistory,
} from '../../../infrastructure/graph/topology-queries.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../../infrastructure/publication/handlers.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { readOrphanObservation } from '../../../infrastructure/sqlite/orphan-observations.js';
import {
  recordSupersessionProposal,
  resolveSupersessionProposal,
  reopenSupersessionProposal,
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

const FIRST = new Date('2026-05-01T00:00:00.000Z');

async function seedUnsupported(id: string): Promise<void> {
  await writeStampedNode(sub.harness.driver, {
    label: 'Insight',
    id,
    now: EARLY,
    properties: { text: id },
  });
  establishNodeSupportScopes(store.db, id, EARLY);
  establishNodeState(store.db, id, { revision: 1, at: EARLY });
}
async function observe(now: Date): Promise<void> {
  await readOrphanCensus(
    { driver: sub.harness.driver, db: store.db },
    { limit: 100, now, forgetAfterDays: 30, policyRevision: 0 },
  );
}
async function suppress(id: string): Promise<void> {
  const result = await coordinator.publish({
    kind: 'topology_update',
    operationId: `suppress-${id}`,
    payload: { nodeId: id, policyRevision: 0, forgetBefore: '2026-08-01T00:00:00.000Z' },
  });
  expect.soft(result.status).toBe('deferred');
  expect((await nodeProperties(sub.harness.driver, id)).forgotten_at).toBeUndefined();
}

it('does not reuse a proposal history version after a same-clock reopen and resolution', async () => {
  const id = 'proposal-repeat-root';
  await seedUnsupported(id);
  const proposal = recordSupersessionProposal(store.db, {
    oldId: id,
    newId: 'proposal-other',
    confidence: 1,
    episodeId: 'raw-source',
    createdAt: EARLY.toISOString(),
  });
  expect(resolveSupersessionProposal(store.db, proposal, FIRST.toISOString())).toBe(true);
  await observe(FIRST);
  expect(readOrphanObservation(store.db, id)?.firstVerifiedAt).toBe(FIRST.toISOString());
  expect(reopenSupersessionProposal(store.db, proposal)).toBe(true);
  expect(resolveSupersessionProposal(store.db, proposal, FIRST.toISOString())).toBe(true);
  await observe(CHECK);
  expect.soft(readOrphanObservation(store.db, id)?.firstVerifiedAt).not.toBe(FIRST.toISOString());
  await suppress(id);
});

it('detects a later stamped association lifecycle', async () => {
  const id = 'mask-a-root';
  const peers = ['mask-z-peer-1', 'mask-z-peer-2'];
  await seedUnsupported(id);
  for (const peer of peers) {
    await writeStampedNode(sub.harness.driver, {
      label: 'Insight',
      id: peer,
      now: EARLY,
      properties: { text: peer },
    });
    await upsertEdge(sub.harness.driver, {
      type: 'RELATED_TO',
      sourceId: id,
      targetId: peer,
      strength: 0.5,
      confidence: 1,
      signals: [],
      provenance: ['fixture'],
      count: 0,
      now: EARLY,
    });
  }
  await closeEdge(sub.harness.driver, 'RELATED_TO', id, peers[0]!, FIRST);
  await closeEdge(
    sub.harness.driver,
    'RELATED_TO',
    id,
    peers[1]!,
    new Date(FIRST.getTime() - 1000),
  );
  await observe(FIRST);
  expect(readOrphanObservation(store.db, id)?.firstVerifiedAt).toBe(FIRST.toISOString());
  const before = (await nodeAssociationHistory(sub.harness.driver, [id])).get(id);
  await upsertEdge(sub.harness.driver, {
    type: 'RELATED_TO',
    sourceId: id,
    targetId: peers[1]!,
    strength: 0.5,
    confidence: 1,
    signals: [],
    provenance: ['fixture'],
    count: 0,
    now: new Date(FIRST.getTime() + 250),
  });
  await closeEdge(sub.harness.driver, 'RELATED_TO', id, peers[1]!, new Date(FIRST.getTime() + 500));
  const after = (await nodeAssociationHistory(sub.harness.driver, [id])).get(id);
  expect.soft(after).not.toBe(before);
  await observe(CHECK);
  expect.soft(readOrphanObservation(store.db, id)?.firstVerifiedAt).not.toBe(FIRST.toISOString());
  await suppress(id);
});

it('does not reuse association history after a lifecycle repeats its supplied clock', async () => {
  const id = 'repeat-a-root';
  const peer = 'repeat-z-peer';
  await seedUnsupported(id);
  await writeStampedNode(sub.harness.driver, {
    label: 'Insight',
    id: peer,
    now: EARLY,
    properties: { text: peer },
  });
  await upsertEdge(sub.harness.driver, {
    type: 'RELATED_TO',
    sourceId: id,
    targetId: peer,
    strength: 0.5,
    confidence: 1,
    signals: [],
    provenance: ['fixture'],
    count: 0,
    now: EARLY,
  });
  await closeEdge(sub.harness.driver, 'RELATED_TO', id, peer, FIRST);
  await observe(FIRST);
  expect(readOrphanObservation(store.db, id)?.firstVerifiedAt).toBe(FIRST.toISOString());
  const before = (await nodeAssociationHistory(sub.harness.driver, [id])).get(id);
  await upsertEdge(sub.harness.driver, {
    type: 'RELATED_TO',
    sourceId: id,
    targetId: peer,
    strength: 0.5,
    confidence: 1,
    signals: [],
    provenance: ['fixture'],
    count: 0,
    now: FIRST,
  });
  expect((await findOrphanNodes(sub.harness.driver, 100)).map((row) => row.id)).not.toContain(id);
  await closeEdge(sub.harness.driver, 'RELATED_TO', id, peer, FIRST);
  expect.soft((await nodeAssociationHistory(sub.harness.driver, [id])).get(id)).not.toBe(before);
  await observe(CHECK);
  expect.soft(readOrphanObservation(store.db, id)?.firstVerifiedAt).not.toBe(FIRST.toISOString());
  await suppress(id);
});

it('does not certify a raw Turn as the retained target of a repair', async () => {
  const sourceId = 'raw-target-source';
  const orphanId = 'raw-target-orphan';
  const targetId = 'raw-target-turn';
  seedSource(store.db, {
    sourceId,
    sessionId: 'raw-target-session',
    identity: 'raw-target',
    content: { turns: [{ role: 'user', text: 'source words' }] },
    turnIds: [targetId],
    now: EARLY,
  });
  establishScope(store.db, sourceId, 'source.state', EARLY);
  await writeStampedNode(sub.harness.driver, {
    label: 'Episode',
    id: sourceId,
    now: EARLY,
    properties: { text: 'source words' },
  });
  await writeStampedNode(sub.harness.driver, {
    label: 'Insight',
    id: orphanId,
    now: EARLY,
    properties: { text: 'retained interpretation' },
  });
  await writeStampedNode(sub.harness.driver, {
    label: 'Turn',
    id: targetId,
    now: EARLY,
    properties: { text: 'source words', role: 'user', sequence: 0 },
  });
  for (const [nodeId, role] of [
    [orphanId, 'extraction'],
    [targetId, 'raw_order'],
  ]) {
    establishNodeState(store.db, nodeId!, { revision: 1, at: EARLY });
    commitIncidence(store.db, {
      sourceId,
      nodeId: nodeId!,
      role: role!,
      operationId: `raw-target-${role}`,
      at: EARLY,
    });
  }
  await upsertEdge(sub.harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: orphanId,
    targetId: sourceId,
    strength: 1,
    confidence: 1,
    signals: [],
    provenance: ['fixture'],
    count: 0,
    now: EARLY,
  });
  await upsertEdge(sub.harness.driver, {
    type: 'PARTICIPATES_IN',
    sourceId: targetId,
    targetId: sourceId,
    strength: 1,
    confidence: 1,
    signals: [],
    provenance: ['fixture'],
    count: 0,
    now: EARLY,
  });
  expect
    .soft((await findOrphanRelinkTargets(sub.harness.driver, [orphanId]))[0]?.targetId)
    .not.toBe(targetId);
  const result = await coordinator.publish({
    kind: 'topology_update',
    operationId: 'raw-target-repair',
    payload: { mode: 'relink', orphanId, targetId, relinkKind: 'same_container' },
  });
  expect.soft(result.status).toBe('deferred');
  expect(await relationshipTypesBetween(sub.harness.driver, orphanId, targetId)).not.toContain(
    'RELATED_TO',
  );
});
