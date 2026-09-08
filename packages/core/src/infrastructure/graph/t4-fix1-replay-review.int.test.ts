import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { bootstrapBackbone } from './backbone.js';
import { runGraphMigrations } from './migrations.js';
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
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { replayExperiences } from '../../reflection/application/replay.js';
import { openLogger } from '../logging/logger.js';
import { recordSourceStateVersion } from '../sqlite/source-lifecycle.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let sessionId: string;
let sessions: SessionManager;

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
  await coordinator.recover();
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

async function reintroduced(
  marker: string,
): Promise<{ first: string; second: string; at: string }> {
  const first = await acceptSource(marker);
  recordSourceStateVersion(store.db, {
    sourceId: first,
    stateKind: 'forgotten',
    operationId: `forget-${marker}`,
    observedAt: NOW,
    knownFrom: NOW,
  });
  const at = new Date(NOW.getTime() + 60000).toISOString();
  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: `second-${marker}`,
    payload: {
      identity: 'member-1',
      sessionId,
      payloadJson: JSON.stringify(content(marker)),
      referencesJson: null,
      lane: null,
      originJson: null,
      pipelineVersion: PIPELINE_VERSION,
      occurredAt: at,
      indexPolicy: 'archive-v1',
      readiness: null,
    },
  });
  if (outcome.status !== 'acknowledged') {
    throw new Error('fixture failed');
  }
  const second = (outcome.result as { sourceId: string }).sourceId;
  expect(second).not.toBe(first);
  return { first, second, at };
}

it('does not restate the canonical predecessors references as the replacement occurrence', async () => {
  const { first, second } = await reintroduced('independent-reference-history');
  const target = await acceptSource('old-reference-target');
  const original = store.db
    .prepare('SELECT payload_json FROM experience_archive WHERE episode_id=?')
    .get(first) as { payload_json: string };
  const payload = JSON.parse(original.payload_json) as Record<string, unknown>;
  payload.provenance = { derived_from: [target] };
  store.db
    .prepare('UPDATE experience_archive SET payload_json=? WHERE episode_id=?')
    .run(JSON.stringify(payload), first);
  const seen: string[] = [];
  const result = await replayExperiences(
    {
      driver: substrate.harness.driver,
      db: store.db,
      sessions,
      logger: openLogger({ filePath: join(dir, 'replay.log'), level: 'fatal' }),
      runner: {
        run: async (episodeId) => {
          seen.push(episodeId);
          return {
            episodeId,
            status: 'completed',
            applied: true,
            summary: { episodeId, durationMs: 0, counts: {}, stages: [], skippedStages: [] },
          };
        },
      },
    },
    { selection: { episodeId: second }, batchSize: 1, clock: () => NOW },
  );
  expect.soft(result.replayed).toBe(1);
  expect.soft(seen).toEqual([second]);
  const edges = await substrate.harness.driver.executeQuery(
    'MATCH (s:AionNode {id:$source})-[r:DERIVES_FROM]->(t:AionNode {id:$target}) RETURN count(r) AS n',
    { source: second, target },
  );
  expect(edges.records[0]?.get('n').toNumber()).toBe(0);
});
