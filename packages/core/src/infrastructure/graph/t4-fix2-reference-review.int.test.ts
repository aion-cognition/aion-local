import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

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
import { replayExperiences } from '../../reflection/application/replay.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';
import { openLogger } from '../logging/logger.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import { SqliteStore } from '../sqlite/database.js';
import { transitionSourceResidency } from '../sqlite/source-lifecycle.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let sessionId: string;
let sessions: SessionManager;
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-reference-publication-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  sessions = new SessionManager(substrate.harness.driver, {
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

it('repairs an original occurrences own durable references after raw rebuild', async () => {
  const target = await acceptSource('repair-target');
  const initial = await coordinator.publish({
    kind: 'intake',
    operationId: 'original-with-refs',
    payload: intakePayload(
      'original-with-refs',
      NOW.toISOString(),
      JSON.stringify({ derived_from: [target] }),
    ),
  });
  expect(initial.status).toBe('acknowledged');
  if (initial.status !== 'acknowledged') {
    throw new Error('fixture');
  }
  const source = (initial.result as { sourceId: string }).sourceId;
  const ids = [
    source,
    ...(
      store.db
        .prepare("SELECT turn_id FROM source_parts WHERE source_id=? AND part_kind='turn'")
        .all(source) as { turn_id: string }[]
    ).map((p) => p.turn_id),
  ];
  await substrate.harness.driver.executeQuery(
    'UNWIND $ids AS id MATCH (n:AionNode {id:id}) SET n.id="retired:"+id REMOVE n:AionNode',
    { ids },
  );
  transitionSourceResidency(store.db, {
    sourceId: source,
    state: 'evicted',
    operationId: 'evict-repair',
    transitionedAt: NOW,
  });
  expect(
    (
      await coordinator.publish({
        kind: 'projection_rebuild',
        operationId: 'rebuild-original',
        payload: { sourceId: source, observedAt: NOW.toISOString() },
      })
    ).status,
  ).toBe('acknowledged');
  const report = await replayExperiences(
    {
      driver: substrate.harness.driver,
      db: store.db,
      sessions,
      logger: openLogger({ filePath: join(dir, 'replay.log'), level: 'fatal' }),
      runner: {
        run: async (episodeId) => ({
          episodeId,
          status: 'completed',
          applied: true,
          summary: { episodeId, durationMs: 0, counts: {}, stages: [], skippedStages: [] },
        }),
      },
    },
    { selection: { episodeId: source }, batchSize: 1, clock: () => NOW },
  );
  expect.soft(report.replayed).toBe(1);
  const edges = await substrate.harness.driver.executeQuery(
    'MATCH (:AionNode {id:$source})-[r:DERIVES_FROM]->(:AionNode {id:$target}) RETURN count(r) AS n',
    { source, target },
  );
  expect(edges.records[0]?.get('n').toNumber()).toBe(1);
});
it('accepts a confirmation whose optional occurrence time is omitted', async () => {
  const target = 'timestamp-optional-target';
  await substrate.harness.driver.executeQuery('CREATE (:AionNode:Memory:Claim {id:$id})', {
    id: target,
  });
  skipRecovery = true;
  const outcome = await coordinator
    .publish({
      kind: 'intake',
      operationId: 'confirmation-no-time',
      payload: intakePayload(
        'confirmation-no-time',
        NOW.toISOString(),
        JSON.stringify({
          confirmations: [{ target, by: 'reviewer', evidence: 'checked receipt' }],
        }),
      ),
    })
    .catch((error: unknown) => error);
  expect.soft(outcome).toMatchObject({ status: 'acknowledged' });
  expect.soft(coordinator.hasPending()).toBe(false);
});
