import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { bootstrapBackbone } from './backbone.js';
import { runGraphMigrations } from './migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { seedRetainedClaim } from './test-support/graph-queries.fixture.js';
import { intakePublication } from '../../reflection/application/intake-publication.js';
import { projectionRebuildPublication } from '../../reflection/application/rebuild-publication.js';
import { statedReferencesPublication } from '../../reflection/application/reference-publication.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import type { PublicationBoundary } from '../publication/types.js';
import { readCurrentCoverageContract } from '../sqlite/coverage-contract.js';
import { SqliteStore } from '../sqlite/database.js';
import { unsettledLinkStates } from '../sqlite/evidence-link-settlement.js';
import { listStatedLinks } from '../sqlite/evidence-links.js';
import { listReferenceBatches } from '../sqlite/source-identity.js';
import {
  listEvidenceAcknowledgments,
  readSourceResidency,
  transitionSourceResidency,
} from '../sqlite/source-lifecycle.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let sessionId: string;
let serial = 0;
let failAt: PublicationBoundary | undefined;

function content(marker: string): ReflectionContent {
  return {
    turns: [{ role: 'user', text: `a turn about ${marker}` }],
    observations: [`an observation about ${marker}`],
  };
}

async function acceptSource(marker: string): Promise<string> {
  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-${marker}`,
    payload: {
      identity: 'member-1',
      sessionId,
      payloadJson: JSON.stringify(content(marker)),
      referencesJson: null,
      lane: null,
      originJson: null,
      pipelineVersion: PIPELINE_VERSION,
      occurredAt: NOW.toISOString(),
      indexPolicy: 'archive-v1',
      readiness: null,
    },
  });
  if (outcome.status !== 'acknowledged') {
    throw new Error(`intake ${marker} was not accepted`);
  }
  return (outcome.result as { sourceId: string }).sourceId;
}

/** One intake that carries a statement, so the reference half runs inside the intake publication. */
function intakePayload(marker: string, targetId: string): Record<string, unknown> {
  return {
    identity: 'member-1',
    sessionId,
    payloadJson: JSON.stringify(content(marker)),
    referencesJson: JSON.stringify({ derived_from: [targetId] }),
    lane: null,
    originJson: null,
    pipelineVersion: PIPELINE_VERSION,
    occurredAt: NOW.toISOString(),
    indexPolicy: 'archive-v1',
    readiness: null,
  };
}

/** Stands in for the activation that lands between a prepared attempt and its recovery. */
function moveCoverageEpoch(marker: string): void {
  store.db
    .prepare('UPDATE coverage_contract SET epoch = ? WHERE epoch = ?')
    .run(`${marker}-activation`, readCurrentCoverageContract(store.db)?.epoch ?? '');
}

function statePayload(
  sourceId: string,
  marker: string,
  targets: { supersedes?: string[]; derivedFrom?: string[] },
): Record<string, unknown> {
  return {
    sourceId,
    supersedes: targets.supersedes ?? [],
    derivedFrom: targets.derivedFrom ?? [],
    confirmations: [],
    deliveryKey: `delivery-${marker}`,
    observedAt: NOW.toISOString(),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-reference-publication-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const sessions = new SessionManager(substrate.harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  ({ sessionId } = await sessions.ensureSession({ identity: 'transport-1', now: NOW }));
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [
      ...PUBLICATION_HANDLERS,
      intakePublication,
      statedReferencesPublication,
      projectionRebuildPublication,
    ],
    now: () => NOW,
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted publication');
      }
    },
  });
  await coordinator.initialize();
}, 120_000);

beforeEach(() => {
  serial += 1;
});

afterEach(async () => {
  await coordinator.recover();
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('records a reference to a resident source as a link version and an edge', async () => {
  const marker = `resident-${String(serial)}`;
  const target = await acceptSource(`${marker}-target`);
  const source = await acceptSource(`${marker}-source`);

  const outcome = await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}`,
    payload: statePayload(source, marker, { derivedFrom: [target] }),
  });

  expect(outcome.status).toBe('acknowledged');
  const result = outcome.status === 'acknowledged' ? outcome.result : undefined;
  expect(result).toMatchObject({ projectedEdges: 1, unresolved: 0 });
  const links = listStatedLinks(store.db, source);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ kind: 'derived_from', qualifier: 'source', toId: target });
  expect(links[0]?.knownFrom).not.toBeNull();
  const edges = await substrate.harness.driver.executeQuery(
    'MATCH (:AionNode { id: $from })-[r:DERIVES_FROM]->(:AionNode { id: $to }) RETURN count(r) AS n',
    { from: source, to: target },
  );
  expect(edges.records[0]?.get('n').toNumber()).toBe(1);
});

it('records a reference to an evicted source against its original identity', async () => {
  const marker = `evicted-${String(serial)}`;
  const target = await acceptSource(`${marker}-target`);
  const source = await acceptSource(`${marker}-source`);
  transitionSourceResidency(store.db, {
    sourceId: target,
    state: 'evicted',
    operationId: 'operation-evict',
    transitionedAt: NOW,
  });
  await substrate.harness.driver.executeQuery('MATCH (e:Episode { id: $id }) SET e:Retired', {
    id: target,
  });
  await substrate.harness.driver.executeQuery(
    'MATCH (e:Episode { id: $id }) REMOVE e:AionNode RETURN e.id AS id',
    { id: target },
  );

  const outcome = await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}`,
    payload: statePayload(source, marker, { supersedes: [target] }),
  });

  expect(outcome.status).toBe('acknowledged');
  const result = outcome.status === 'acknowledged' ? outcome.result : undefined;
  // The endpoint has no projection, so no edge is written; the statement is durable anyway and
  // the target is a known source rather than an unknown id.
  expect(result).toMatchObject({ projectedEdges: 0, unresolved: 0 });
  const links = listStatedLinks(store.db, source);
  expect(links[0]).toMatchObject({ kind: 'corrects', qualifier: 'source', toId: target });
  expect(links[0]?.knownFrom).not.toBeNull();
});

it('keeps an unknown target durably stated and unresolved', async () => {
  const marker = `unknown-${String(serial)}`;
  const source = await acceptSource(`${marker}-source`);

  const outcome = await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}`,
    payload: statePayload(source, marker, { derivedFrom: ['never-seen-id'] }),
  });

  expect(outcome.status).toBe('acknowledged');
  expect(outcome.status === 'acknowledged' ? outcome.result : undefined).toMatchObject({
    projectedEdges: 0,
    unresolved: 1,
  });
  expect(listStatedLinks(store.db, source)[0]).toMatchObject({
    qualifier: 'unresolved',
    toId: 'never-seen-id',
  });
});

it('accepts a part of another source as its own kind of target', async () => {
  const marker = `part-${String(serial)}`;
  const target = await acceptSource(`${marker}-target`);
  const source = await acceptSource(`${marker}-source`);
  const turnId = (
    store.db
      .prepare("SELECT turn_id FROM source_parts WHERE source_id = ? AND part_kind = 'turn'")
      .get(target) as { turn_id: string }
  ).turn_id;

  await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}`,
    payload: statePayload(source, marker, { derivedFrom: [turnId] }),
  });

  expect(listStatedLinks(store.db, source)[0]).toMatchObject({
    qualifier: 'part',
    toId: turnId,
  });
});

it('takes a retried delivery as one accepted version, not two', async () => {
  const marker = `retry-${String(serial)}`;
  const target = await acceptSource(`${marker}-target`);
  const source = await acceptSource(`${marker}-source`);
  const request = {
    kind: 'stated_references' as const,
    operationId: `references-${marker}`,
    payload: statePayload(source, marker, { derivedFrom: [target] }),
  };

  const first = await coordinator.publish(request);

  expect(await coordinator.publish(request)).toEqual(first);
  expect(listReferenceBatches(store.db, source)).toHaveLength(2);
  expect(listStatedLinks(store.db, source)).toHaveLength(1);
  expect(
    listEvidenceAcknowledgments(store.db, source).filter(
      (entry) => entry.effectKind === 'stated_references',
    ),
  ).toMatchObject([{ referenceVersion: 2, state: 'completed' }]);
});

/** The version row behind one statement, as the records hold it rather than as a reader sees it. */
function versionRow(linkId: string): { operation_id: string | null; known_from: string | null } {
  return store.db
    .prepare('SELECT operation_id, known_from FROM evidence_link_versions WHERE link_id = ?')
    .get(linkId) as { operation_id: string | null; known_from: string | null };
}

it('settles a delivery whose first attempt was prepared and then discarded', async () => {
  const marker = `readopted-${String(serial)}`;
  const target = await acceptSource(`${marker}-target`);
  const source = await acceptSource(`${marker}-source`);
  const payload = statePayload(source, marker, { derivedFrom: [target] });

  failAt = 'prepared';
  await expect(
    coordinator.publish({
      kind: 'stated_references',
      operationId: `references-${marker}-1`,
      payload,
    }),
  ).rejects.toThrow();
  expect(listStatedLinks(store.db, source)[0]?.knownFrom).toBeNull();

  // An activation lands in the gap, so the recovery's recheck defers and the attempt is discarded
  // with its prepared version left where a retry can find it.
  moveCoverageEpoch(marker);
  expect(await coordinator.recover()).toMatchObject({ status: 'deferred' });
  expect(unsettledLinkStates(store.db, source)).toEqual(['stated']);

  const retry = await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}-2`,
    payload,
  });

  expect(retry.status).toBe('acknowledged');
  const links = listStatedLinks(store.db, source);
  expect(links).toHaveLength(1);
  expect(links[0]?.knownFrom).not.toBeNull();
  expect(versionRow(links[0]?.linkId ?? '')).toMatchObject({
    operation_id: `references-${marker}-2`,
  });
  // Nothing is owed, so the eviction fence has no settlement to pin this source on.
  expect(unsettledLinkStates(store.db, source)).toEqual([]);
  expect(
    listEvidenceAcknowledgments(store.db, source).filter(
      (entry) => entry.effectKind === 'stated_references',
    ),
  ).toMatchObject([{ state: 'completed' }]);
});

it('leaves a settled version with the operation that committed it', async () => {
  const marker = `committed-${String(serial)}`;
  const target = await acceptSource(`${marker}-target`);
  const source = await acceptSource(`${marker}-source`);
  const payload = statePayload(source, marker, { derivedFrom: [target] });

  expect(
    (
      await coordinator.publish({
        kind: 'stated_references',
        operationId: `references-${marker}-1`,
        payload,
      })
    ).status,
  ).toBe('acknowledged');
  const linkId = listStatedLinks(store.db, source)[0]?.linkId ?? '';
  const settled = versionRow(linkId);

  const later = await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}-2`,
    payload,
  });

  expect(later.status).toBe('acknowledged');
  // A later attempt on the same delivery has no standing over a version that already published:
  // the row keeps the operation that settled it and the moment it entered the committed view.
  expect(versionRow(linkId)).toEqual(settled);
  expect(settled.operation_id).toBe(`references-${marker}-1`);
  expect(listStatedLinks(store.db, source)).toHaveLength(1);
});

it('settles a delivery whose retry classifies its target differently', async () => {
  const marker = `reclassified-${String(serial)}`;
  const source = await acceptSource(`${marker}-source`);
  const target = `claim-${marker}`;
  const payload = statePayload(source, marker, { derivedFrom: [target] });

  failAt = 'prepared';
  await expect(
    coordinator.publish({
      kind: 'stated_references',
      operationId: `references-${marker}-1`,
      payload,
    }),
  ).rejects.toThrow();
  // Nothing accounts for the target yet, so the statement is recorded against an unresolved id.
  expect(listStatedLinks(store.db, source)[0]).toMatchObject({
    qualifier: 'unresolved',
    knownFrom: null,
  });

  moveCoverageEpoch(marker);
  expect(await coordinator.recover()).toMatchObject({ status: 'deferred' });
  // The substrate starts holding the target between the discarded attempt and the retry, so the
  // retry classifies it differently and the link address it writes under moves with the class.
  await seedRetainedClaim(substrate.harness.driver, { id: target, sourceId: source });

  const retry = await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}-2`,
    payload,
  });

  expect(retry.status).toBe('acknowledged');
  const links = listStatedLinks(store.db, source);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ qualifier: 'retained_node', toId: target });
  expect(links[0]?.knownFrom).not.toBeNull();
  // The address the first attempt wrote under is one nothing will name again, so its row is
  // released rather than left owed: the source keeps no obligation the eviction fence pins on.
  expect(unsettledLinkStates(store.db, source)).toEqual([]);
  expect(
    listEvidenceAcknowledgments(store.db, source).filter(
      (entry) => entry.effectKind === 'stated_references',
    ),
  ).toMatchObject([{ state: 'completed' }]);
});

it('settles an intake delivery whose retry classifies its target differently', async () => {
  const marker = `intake-reclassified-${String(serial)}`;
  const target = `claim-${marker}`;

  failAt = 'prepared';
  await expect(
    coordinator.publish({
      kind: 'intake',
      operationId: `intake-${marker}-1`,
      payload: intakePayload(marker, target),
    }),
  ).rejects.toThrow();
  const source = (
    store.db
      .prepare('SELECT source_id FROM source_reference_batches ORDER BY rowid DESC LIMIT 1')
      .get() as { source_id: string }
  ).source_id;
  expect(listStatedLinks(store.db, source)[0]).toMatchObject({
    qualifier: 'unresolved',
    knownFrom: null,
  });

  moveCoverageEpoch(marker);
  expect(await coordinator.recover()).toMatchObject({ status: 'deferred' });
  await seedRetainedClaim(substrate.harness.driver, { id: target, sourceId: source });

  // The same push again: the occurrence is already held, and the delivery key is the set it
  // carried rather than the classes that set resolved to, so the retry offers the same delivery.
  const retry = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-${marker}-2`,
    payload: intakePayload(marker, target),
  });

  expect(retry.status).toBe('acknowledged');
  const links = listStatedLinks(store.db, source);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ qualifier: 'retained_node', knownFrom: expect.any(String) });
  expect(unsettledLinkStates(store.db, source)).toEqual([]);
});

it('refuses a statement about a source the records do not hold', async () => {
  const marker = `absent-${String(serial)}`;

  const outcome = await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}`,
    payload: statePayload('no-such-source', marker, { derivedFrom: [] }),
  });

  expect(outcome).toMatchObject({ status: 'rejected', reason: 'source_unknown' });
});

/** Removes a source's raw projection the way an eviction does, leaving its records behind. */
async function evict(sourceId: string): Promise<void> {
  transitionSourceResidency(store.db, {
    sourceId,
    state: 'evicted',
    operationId: `evict-${sourceId}`,
    transitionedAt: NOW,
  });
  await substrate.harness.driver.executeQuery('MATCH (n:AionNode { id: $id }) REMOVE n:AionNode', {
    id: sourceId,
  });
  const turnIds = store.db
    .prepare("SELECT turn_id FROM source_parts WHERE source_id = ? AND part_kind = 'turn'")
    .all(sourceId) as { turn_id: string }[];
  for (const row of turnIds) {
    await substrate.harness.driver.executeQuery(
      'MATCH (n:AionNode { id: $id }) REMOVE n:AionNode',
      { id: row.turn_id },
    );
  }
}

it('puts an evicted projection back under the ids it always had', async () => {
  const marker = `rebuild-${String(serial)}`;
  const sourceId = await acceptSource(marker);
  const turnIds = (
    store.db
      .prepare("SELECT turn_id FROM source_parts WHERE source_id = ? AND part_kind = 'turn'")
      .all(sourceId) as { turn_id: string }[]
  ).map((row) => row.turn_id);
  await evict(sourceId);
  const before = readSourceResidency(store.db, sourceId)?.projectionGeneration ?? 0;

  const outcome = await coordinator.publish({
    kind: 'projection_rebuild',
    operationId: `rebuild-${marker}`,
    payload: { sourceId, observedAt: NOW.toISOString() },
  });

  expect(outcome.status).toBe('acknowledged');
  expect(outcome.status === 'acknowledged' ? outcome.result : undefined).toMatchObject({
    sourceId,
    turnIds,
    pinnedOversized: [],
  });
  const residency = readSourceResidency(store.db, sourceId);
  expect(residency).toMatchObject({ state: 'resident', projectionGeneration: before + 1 });
  expect(residency?.rebuildAckAt).not.toBeNull();
  const nodes = await substrate.harness.driver.executeQuery(
    'UNWIND $ids AS id MATCH (n:AionNode { id: id }) RETURN count(n) AS n',
    { ids: [sourceId, ...turnIds] },
  );
  expect(nodes.records[0]?.get('n').toNumber()).toBe(turnIds.length + 1);
  // Raw reconstruction and semantic processing never share a row: the rebuild discharges only
  // its own effect, and nothing it did queued extraction or appended feedback.
  expect(
    listEvidenceAcknowledgments(store.db, sourceId).filter(
      (entry) => entry.effectKind === 'raw_rebuild',
    ),
  ).toMatchObject([{ state: 'completed' }]);
  expect(
    listEvidenceAcknowledgments(store.db, sourceId).filter(
      (entry) => entry.effectKind === 'semantic_processing',
    ),
  ).toMatchObject([{ state: 'owed' }]);
});

it('refuses to restore an id an unrelated node now occupies', async () => {
  const marker = `occupied-${String(serial)}`;
  const sourceId = await acceptSource(marker);
  await evict(sourceId);
  await substrate.harness.driver.executeQuery(
    'MATCH (n { id: $id }) SET n:AionNode SET n.occupied_by = "someone-else"',
    { id: sourceId },
  );

  const outcome = await coordinator.publish({
    kind: 'projection_rebuild',
    operationId: `rebuild-${marker}`,
    payload: { sourceId, observedAt: NOW.toISOString() },
  });

  expect(outcome).toMatchObject({ status: 'rejected', reason: 'original_ids_occupied' });
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('evicted');
});

it('refuses to rebuild a source whose projection is already there', async () => {
  const marker = `resident-rebuild-${String(serial)}`;
  const sourceId = await acceptSource(marker);

  const outcome = await coordinator.publish({
    kind: 'projection_rebuild',
    operationId: `rebuild-${marker}`,
    payload: { sourceId, observedAt: NOW.toISOString() },
  });

  expect(outcome).toMatchObject({ status: 'rejected', reason: 'source_not_evicted' });
});
