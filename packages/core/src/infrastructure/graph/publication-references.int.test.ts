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
import { intakePublication } from '../../reflection/application/intake-publication.js';
import { statedReferencesPublication } from '../../reflection/application/reference-publication.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import { SqliteStore } from '../sqlite/database.js';
import { listStatedLinks } from '../sqlite/evidence-links.js';
import { listReferenceBatches } from '../sqlite/source-identity.js';
import {
  listEvidenceAcknowledgments,
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
    handlers: [...PUBLICATION_HANDLERS, intakePublication, statedReferencesPublication],
    now: () => NOW,
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

it('refuses a statement about a source the records do not hold', async () => {
  const marker = `absent-${String(serial)}`;

  const outcome = await coordinator.publish({
    kind: 'stated_references',
    operationId: `references-${marker}`,
    payload: statePayload('no-such-source', marker, { derivedFrom: [] }),
  });

  expect(outcome).toMatchObject({ status: 'rejected', reason: 'source_unknown' });
});
