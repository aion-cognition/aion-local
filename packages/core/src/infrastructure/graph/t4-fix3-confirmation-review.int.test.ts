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
import { fromGraphDateTime } from './values.js';
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
import { mergeExperienceProvenance } from '../sqlite/experience-archive.js';
import { transitionSourceResidency } from '../sqlite/source-lifecycle.js';

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

async function acceptConfirmation(
  marker: string,
  stated: boolean,
): Promise<{ source: string; target: string }> {
  const target = `target-${marker}`;
  await substrate.harness.driver.executeQuery('CREATE (:AionNode:Memory:Claim {id:$id})', {
    id: target,
  });
  const result = await coordinator.publish({
    kind: 'intake',
    operationId: marker,
    payload: intakePayload(
      marker,
      NOW.toISOString(),
      JSON.stringify({
        confirmations: [
          {
            target,
            by: 'canonical',
            evidence: 'first accepted receipt',
            ...(stated ? { occurred_at: '2020-01-01T00:00:00.000Z' } : {}),
          },
        ],
      }),
    ),
  });
  if (result.status !== 'acknowledged') {
    throw new Error('fixture');
  }
  return { source: (result.result as { sourceId: string }).sourceId, target };
}
async function rebuildAndReplay(source: string): Promise<void> {
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
    operationId: `evict-${source}`,
    transitionedAt: NOW,
  });
  expect(
    (
      await coordinator.publish({
        kind: 'projection_rebuild',
        operationId: `rebuild-${source}`,
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
    {
      selection: { episodeId: source },
      batchSize: 1,
      clock: () => new Date(NOW.getTime() + 3600000),
    },
  );
  expect(report.replayed).toBe(1);
}
it('preserves the original resolved confirmation time through raw rebuild and replay', async () => {
  const { source, target } = await acceptConfirmation('fallback-time', false);
  await rebuildAndReplay(source);
  const rows = await substrate.harness.driver.executeQuery(
    'MATCH (:AionNode {id:$source})-[r:EVIDENCES]->(:AionNode {id:$target}) RETURN r.confirmed_at AS at',
    { source, target },
  );
  expect(fromGraphDateTime(rows.records[0]?.get('at'))?.toISOString()).toBe(NOW.toISOString());
});
it('does not overwrite a canonical confirmation with a later archive compatibility value', async () => {
  const { source, target } = await acceptConfirmation('canonical-first', true);
  expect(
    mergeExperienceProvenance(store.db, source, {
      confirmations: [
        {
          target,
          by: 'later compatibility',
          evidence: 'later payload',
          occurred_at: '2021-01-01T00:00:00.000Z',
        },
      ],
    }),
  ).toBe(true);
  await rebuildAndReplay(source);
  const rows = await substrate.harness.driver.executeQuery(
    'MATCH (:AionNode {id:$source})-[r:EVIDENCES]->(:AionNode {id:$target}) RETURN r.confirmed_by AS by, r.confirmation_evidence AS evidence',
    { source, target },
  );
  expect(rows.records[0]?.toObject()).toEqual({
    by: 'canonical',
    evidence: 'first accepted receipt',
  });
});
