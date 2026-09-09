import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';

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
import { fromGraphDateTime } from './values.js';
import { replayExperiences } from '../../reflection/application/replay.js';
import { openLogger } from '../logging/logger.js';
import { PublicationOperation } from '../publication/operation.js';
import { buildEvidenceRevision } from '../publication/preconditions.js';
import { readCurrentCoverageContract } from '../sqlite/coverage-contract.js';
import { publicationRecord } from '../sqlite/publication-coordinator-store.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../sqlite/publication-intents.js';
import { readSourceRecord } from '../sqlite/source-identity.js';
import { recordSourceStateVersion, transitionSourceResidency } from '../sqlite/source-lifecycle.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let sessionId: string;
let serial = 0;
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
  // The statement counts once its own publication is acknowledged, which is what the committed
  // read asks for: a timestamp on the row is not an acknowledgment.
  preparePublicationIntent(store.db, {
    operationId: `forget-${marker}`,
    kind: 'source_suppression',
    payloadDigest: `digest-${marker}`,
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
  acknowledgePublicationIntent(store.db, {
    operationId: `forget-${marker}`,
    resultDigest: `result-${marker}`,
    resultJson: '{}',
    observedAckAt: NOW,
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

it('replays a selected new occurrence even when its canonical bytes belong to a forgotten predecessor', async () => {
  const { second } = await reintroduced(`replay-occurrence-${serial}`);
  const seen: string[] = [];
  const report = await replayExperiences(
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
  expect.soft(report.scanned).toBe(1);
  expect.soft(seen).toEqual([second]);
});

it('rebuilds the original occurrence fallback clock rather than the canonical rows older clock', async () => {
  const { second, at } = await reintroduced(`rebuild-clock-${serial}`);
  expect(readSourceRecord(store.db, second)?.occurredAt).toBe(at);
  const ids = [
    second,
    ...(
      store.db
        .prepare("SELECT turn_id FROM source_parts WHERE source_id=? AND part_kind='turn'")
        .all(second) as { turn_id: string }[]
    ).map((x) => x.turn_id),
  ];
  transitionSourceResidency(store.db, {
    sourceId: second,
    state: 'evicted',
    operationId: 'evicted',
    transitionedAt: NOW,
  });
  await substrate.harness.driver.executeQuery(
    'UNWIND $ids AS id MATCH (n:AionNode {id:id}) SET n.id="retired:"+id REMOVE n:AionNode',
    { ids },
  );
  await coordinator.publish({
    kind: 'projection_rebuild',
    operationId: `rebuild-clock-${serial}`,
    payload: { sourceId: second, observedAt: NOW.toISOString() },
  });
  const row = await substrate.harness.driver.executeQuery(
    'MATCH (n:Episode {id:$id}) RETURN n.occurred_at AS occurred',
    { id: second },
  );
  expect(fromGraphDateTime(row.records[0]?.get('occurred'))?.toISOString()).toBe(at);
});

it('records fresh rejection without running prepareSqlite or cleanup that requires prepared resources', async () => {
  let prepared = 0;
  let discarded = 0;
  const handler = new PublicationOperation({
    kind: 'semantic_write',
    effectKinds: [],
    payload: z.strictObject({ accepted: z.string() }),
    data: z.strictObject({ accepted: z.string() }),
    result: z.null(),
    prepare: async (ctx, payload) => ({
      data: payload,
      expected: {
        coverageEpoch: readCurrentCoverageContract(ctx.db)?.epoch ?? '',
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      scopes: [],
      effects: [],
    }),
    check: async () => ({ status: 'rejected' as const, reason: 'invalid_selection' }),
    applyGraph: async () => {
      throw new Error('must not apply');
    },
    prepareSqlite: () => {
      prepared++;
      return undefined;
    },
    acknowledgeSqlite: () => {
      throw new Error('must not acknowledge');
    },
    discardSqlite: () => {
      discarded++;
      return undefined;
    },
  });
  const owner = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    handlers: [handler],
    logger,
    now: () => NOW,
  });
  await owner.initialize();
  const result = await owner.publish({
    kind: 'semantic_write',
    operationId: 'fresh-reject-contract',
    payload: { accepted: 'retain this input' },
  });
  expect(result).toMatchObject({ status: 'rejected', reason: 'invalid_selection' });
  expect(prepared).toBe(0);
  expect(discarded).toBe(0);
  expect(publicationRecord(store.db, 'fresh-reject-contract')?.payloadJson).toContain(
    'retain this input',
  );
  expect(owner.hasPending()).toBe(false);
});
