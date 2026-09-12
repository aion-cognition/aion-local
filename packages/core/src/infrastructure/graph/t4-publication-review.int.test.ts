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
import { projectionRebuildPublication } from '../../reflection/application/rebuild-publication.js';
import { statedReferencesPublication } from '../../reflection/application/reference-publication.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import { SqliteStore } from '../sqlite/database.js';
import {
  prepareScopeAdvance,
  acknowledgeScopeAdvance,
  publishedScopeToken,
} from '../sqlite/evidence-scope.js';
import { readActiveGeneration } from '../sqlite/processing-generations.js';
import { listReferenceBatches, readSourceRecord } from '../sqlite/source-identity.js';
import {
  listEvidenceAcknowledgments,
  transitionSourceResidency,
} from '../sqlite/source-lifecycle.js';
import { isSourceForgotten, recordSourceStateVersion } from '../sqlite/source-state-versions.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let sessionId: string;
let serial = 0;
let skipRecovery = false;

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
    handlers: [
      ...PUBLICATION_HANDLERS,
      intakePublication,
      statedReferencesPublication,
      projectionRebuildPublication,
    ],
    now: () => NOW,
  });
  await coordinator.initialize();
}, 120_000);

beforeEach(() => {
  serial += 1;
});

afterEach(async () => {
  if (!skipRecovery) {
    await coordinator.recover();
  }
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

function intakePayload(
  marker: string,
  occurredAt = NOW.toISOString(),
  referencesJson: string | null = null,
) {
  return {
    identity: 'member-1',
    sessionId,
    payloadJson: JSON.stringify(content(marker)),
    referencesJson,
    lane: null,
    originJson: null,
    pipelineVersion: PIPELINE_VERSION,
    occurredAt,
    indexPolicy: 'archive-v1',
    readiness: null,
  };
}

it('accepts a new reference batch on the original source when intake reuses an occurrence', async () => {
  const marker = `duplicate-refs-${serial}`;
  const source = await acceptSource(marker);
  const target = await acceptSource(`${marker}-target`);
  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: `second-${marker}`,
    payload: intakePayload(marker, NOW.toISOString(), JSON.stringify({ derived_from: [target] })),
  });
  expect(outcome).toMatchObject({ status: 'acknowledged', result: { sourceId: source } });
  expect(listReferenceBatches(store.db, source)).toHaveLength(2);
});

it('dates acceptance with the substrate clock when the experience is backdated', async () => {
  const marker = `backdated-${serial}`;
  const old = '2020-01-01T00:00:00.000Z';
  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: marker,
    payload: intakePayload(marker, old),
  });
  if (outcome.status !== 'acknowledged') {
    throw new Error('fixture failed');
  }
  const source = (outcome.result as { sourceId: string }).sourceId;
  const archive = store.db
    .prepare('SELECT occurred_at, archived_at FROM experience_archive WHERE episode_id = ?')
    .get(source);
  expect.soft(archive).toEqual({ occurred_at: old, archived_at: NOW.toISOString() });
  expect
    .soft(store.db.prepare('SELECT recorded_at FROM ingest_log WHERE source_id = ?').get(source))
    .toEqual({ recorded_at: NOW.toISOString() });
  expect.soft(listReferenceBatches(store.db, source)[0]?.receivedAt).toBe(NOW.toISOString());
});

it('publishes scope and readiness revisions with the first accepted correction', async () => {
  const marker = `scope-${serial}`;
  const source = await acceptSource(`${marker}-source`);
  const target = await acceptSource(`${marker}-target`);
  const key = { endpointId: target, relationClass: 'sqlite:stated_correction:in' };
  const advance = { ...key, operationId: 'baseline', updatedAt: NOW };
  prepareScopeAdvance(store.db, advance);
  acknowledgeScopeAdvance(store.db, { ...advance, censusStatus: 'established' });
  const token = publishedScopeToken(store.db, key);
  const revision = readActiveGeneration(store.db, source)?.operationalRevision ?? -1;
  await coordinator.publish({
    kind: 'stated_references',
    operationId: marker,
    payload: statePayload(source, marker, { supersedes: [target] }),
  });
  expect.soft(publishedScopeToken(store.db, key)).not.toBe(token);
  expect
    .soft(readActiveGeneration(store.db, source)?.operationalRevision)
    .toBeGreaterThan(revision);
});

it('keeps unacknowledged forget versions outside the current occurrence decision', async () => {
  const source = await acceptSource(`pending-forget-${serial}`);
  recordSourceStateVersion(store.db, {
    sourceId: source,
    stateKind: 'forgotten',
    operationId: 'not-acknowledged',
    observedAt: NOW,
  });
  expect(isSourceForgotten(store.db, source)).toBe(false);
});

it('persists confirmation fields and appends the required event before acknowledgment', async () => {
  const marker = `confirmation-${serial}`;
  const source = await acceptSource(marker);
  const target = `claim-${marker}`;
  await substrate.harness.driver.executeQuery('CREATE (:AionNode:Memory:Claim {id:$id})', {
    id: target,
  });
  const confirmation = {
    target,
    by: 'reviewer',
    evidence: 'checked the original receipt',
    occurredAt: '2020-01-01T00:00:00.000Z',
  };
  const outcome = await coordinator.publish({
    kind: 'stated_references',
    operationId: marker,
    payload: { ...statePayload(source, marker, {}), confirmations: [confirmation] },
  });
  expect(outcome.status).toBe('acknowledged');
  const eventCount = store.db
    .prepare("SELECT count(*) AS n FROM usage_events WHERE kind = 'memory_confirmed'")
    .get() as { n: number };
  expect.soft(eventCount.n).toBe(1);
  const version = store.db
    .prepare(
      'SELECT v.recorded_values_json FROM evidence_links l JOIN evidence_link_versions v ON v.link_id=l.link_id WHERE l.from_id=? AND l.to_id=?',
    )
    .get(source, target) as { recorded_values_json: string };
  expect.soft(JSON.parse(version.recorded_values_json)).toMatchObject({
    by: confirmation.by,
    evidence: confirmation.evidence,
    occurredAt: confirmation.occurredAt,
  });
});

it('settles a late reference from an evicted source without reconstructing that source', async () => {
  const marker = `evicted-author-${serial}`;
  const source = await acceptSource(marker);
  const target = await acceptSource(`${marker}-target`);
  transitionSourceResidency(store.db, {
    sourceId: source,
    state: 'evicted',
    operationId: `evict-${marker}`,
    transitionedAt: NOW,
  });
  await substrate.harness.driver.executeQuery('MATCH (n:AionNode {id:$id}) REMOVE n:AionNode', {
    id: source,
  });
  try {
    await expect(
      coordinator.publish({
        kind: 'stated_references',
        operationId: marker,
        payload: statePayload(source, marker, { derivedFrom: [target] }),
      }),
    ).resolves.toMatchObject({ status: 'acknowledged' });
  } finally {
    await substrate.harness.driver.executeQuery('MATCH (n {id:$id}) SET n:AionNode', {
      id: source,
    });
    await coordinator.recover();
  }
});

it('revalidates a target projection before replaying a prepared reference', async () => {
  const marker = `stale-projection-${serial}`;
  const source = await acceptSource(marker);
  const target = await acceptSource(`${marker}-target`);
  let interrupt = true;
  const interrupted = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, statedReferencesPublication],
    now: () => NOW,
    boundary: ({ boundary }) => {
      if (boundary === 'prepared' && interrupt) {
        interrupt = false;
        throw new Error('interrupted');
      }
    },
  });
  await interrupted.initialize();
  await expect(
    interrupted.publish({
      kind: 'stated_references',
      operationId: marker,
      payload: statePayload(source, marker, { derivedFrom: [target] }),
    }),
  ).rejects.toThrow();
  transitionSourceResidency(store.db, {
    sourceId: target,
    state: 'evicted',
    operationId: 'external-maintenance',
    transitionedAt: NOW,
  });
  await substrate.harness.driver.executeQuery('MATCH (n:AionNode {id:$id}) REMOVE n:AionNode', {
    id: target,
  });
  try {
    await expect(interrupted.recover()).resolves.toBeDefined();
  } finally {
    await substrate.harness.driver.executeQuery('MATCH (n {id:$id}) SET n:AionNode', {
      id: target,
    });
    await interrupted.recover();
  }
});

it('refuses raw reconstruction when the archived content no longer matches the verified proof', async () => {
  const marker = `proof-${serial}`;
  const source = await acceptSource(marker);
  const record = readSourceRecord(store.db, source);
  const turnIds = (
    store.db
      .prepare("SELECT turn_id FROM source_parts WHERE source_id=? AND part_kind='turn'")
      .all(source) as { turn_id: string }[]
  ).map((row) => row.turn_id);
  transitionSourceResidency(store.db, {
    sourceId: source,
    state: 'evicted',
    operationId: `evict-${marker}`,
    transitionedAt: NOW,
  });
  // Free the original IDs without deleting fixture nodes. A rebuild must create fresh projections.
  await substrate.harness.driver.executeQuery(
    'UNWIND $ids AS id MATCH (n:AionNode {id:id}) SET n.id = "retired:" + id REMOVE n:AionNode',
    { ids: [source, ...turnIds] },
  );
  store.db.prepare('UPDATE experience_archive SET payload_json=? WHERE id=?').run(
    JSON.stringify({
      turns: [{ role: 'user', text: 'A DIFFERENT STATEMENT' }],
      observations: ['changed'],
    }),
    record?.canonicalArchiveId,
  );
  const outcome = await coordinator.publish({
    kind: 'projection_rebuild',
    operationId: marker,
    payload: { sourceId: source, observedAt: NOW.toISOString() },
  });
  expect(outcome.status).not.toBe('acknowledged');
});

it('answers a second identical reference delivery from its no-change receipt', async () => {
  const marker = `same-reference-${serial}`;
  const source = await acceptSource(marker);
  const target = await acceptSource(`${marker}-target`);
  await coordinator.publish({
    kind: 'stated_references',
    operationId: `${marker}-1`,
    payload: statePayload(source, `${marker}-1`, { derivedFrom: [target] }),
  });
  skipRecovery = true;
  const next = await coordinator
    .publish({
      kind: 'stated_references',
      operationId: `${marker}-2`,
      payload: statePayload(source, `${marker}-2`, { derivedFrom: [target] }),
    })
    .catch((err: unknown) => err);
  expect.soft(next).toMatchObject({ status: 'acknowledged' });
  expect.soft(coordinator.hasPending()).toBe(false);
  // Recovery must not fail and must find nothing wedged. Once the no-change delivery answers
  // from its receipt the second publish acknowledges outright, so there is no pending operation
  // left for recovery to finish: `undefined` here is the fixed behaviour, an Error is the defect.
  const recovered: unknown = await coordinator.recover().catch((err: unknown) => err);
  expect.soft(recovered).not.toBeInstanceOf(Error);
  expect
    .soft(recovered === undefined || (recovered as { status?: string }).status === 'acknowledged')
    .toBe(true);
  const unrelated = await coordinator
    .publish({
      kind: 'intake',
      operationId: `unrelated-${marker}`,
      payload: intakePayload(`unrelated-${marker}`),
    })
    .catch((err: unknown) => err);
  expect.soft(unrelated).toMatchObject({ status: 'acknowledged' });
  expect(listReferenceBatches(store.db, source)).toHaveLength(2);
});

it('keeps the first accepted confirmation payload and appends no second event on a retry', async () => {
  const marker = `confirmation-retry-${String(serial)}`;
  const source = await acceptSource(marker);
  const target = `claim-${marker}`;
  await substrate.harness.driver.executeQuery('CREATE (:AionNode:Memory:Claim {id:$id})', {
    id: target,
  });
  const confirmation = {
    target,
    by: 'reviewer',
    evidence: 'checked the original receipt',
    occurredAt: '2020-01-01T00:00:00.000Z',
  };
  const request = {
    kind: 'stated_references' as const,
    operationId: marker,
    payload: { ...statePayload(source, marker, {}), confirmations: [confirmation] },
  };

  const first = await coordinator.publish(request);
  const events = (): number =>
    (
      store.db
        .prepare("SELECT count(*) AS n FROM usage_events WHERE kind = 'memory_confirmed'")
        .get() as { n: number }
    ).n;
  const after = events();

  expect(await coordinator.publish(request)).toEqual(first);
  expect(events()).toBe(after);
  const values = store.db
    .prepare(
      `SELECT v.recorded_values_json FROM evidence_links l
       JOIN evidence_link_versions v ON v.link_id = l.link_id
       WHERE l.from_id = ? AND l.to_id = ? ORDER BY v.version LIMIT 1`,
    )
    .get(source, target) as { recorded_values_json: string };
  expect(JSON.parse(values.recorded_values_json)).toMatchObject({
    by: confirmation.by,
    evidence: confirmation.evidence,
    occurredAt: confirmation.occurredAt,
  });
});

it('leaves the settlement owed when the confirmation event cannot be appended', async () => {
  const marker = `confirmation-failure-${String(serial)}`;
  const source = await acceptSource(marker);
  const target = `claim-${marker}`;
  await substrate.harness.driver.executeQuery('CREATE (:AionNode:Memory:Claim {id:$id})', {
    id: target,
  });
  const request = {
    kind: 'stated_references' as const,
    operationId: marker,
    payload: {
      ...statePayload(source, marker, {}),
      confirmations: [
        {
          target,
          by: 'reviewer',
          evidence: 'checked the original receipt',
          occurredAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    },
  };

  // A reversible rename, so the append fails against a real store and nothing is dropped.
  store.db.exec('ALTER TABLE usage_events RENAME TO usage_events_withheld');
  try {
    await expect(coordinator.publish(request)).rejects.toThrow();
    expect(
      listEvidenceAcknowledgments(store.db, source).filter(
        (entry) => entry.effectKind === 'stated_references',
      ),
    ).toMatchObject([{ state: 'owed' }]);
  } finally {
    store.db.exec('ALTER TABLE usage_events_withheld RENAME TO usage_events');
  }

  // The obligation survived the failure, so recovery finishes it rather than losing it.
  const recovered = await coordinator.recover();
  expect(recovered).toMatchObject({ status: 'acknowledged' });
  expect(
    listEvidenceAcknowledgments(store.db, source).filter(
      (entry) => entry.effectKind === 'stated_references',
    ),
  ).toMatchObject([{ state: 'completed' }]);
});
