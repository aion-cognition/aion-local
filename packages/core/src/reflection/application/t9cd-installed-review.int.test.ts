import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import type { ReflectionRun } from './orchestrator.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { ReflectionWorker } from './worker.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import { SessionManager } from '../../session/session-manager.js';

/** Nothing in this battery generates or embeds; a call that reaches it is a fault the test wants to see. */
const batteryEmbedder = {
  embed: (): Promise<never[]> => Promise.reject(new Error('no embedding in this battery')),
  generate: (): Promise<never> => Promise.reject(new Error('no generation in this battery')),
};

/**
 * The two converted writers, driven through a real coordinator against real stores.
 *
 * The subject is the wiring rather than the operations: an acceptance and a completion each
 * reaching their stores only through a publication, and each resuming what it already minted
 * when the process is interrupted between the graph write and the acknowledgment.
 *
 * No provider is constructed anywhere in this file's import graph and nothing generates or
 * embeds: the pipeline is a stub runner reporting dispositions.
 */

const NOW = new Date('2026-09-08T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const STAGES = ['entities', 'cognitive'];

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let failAt: PublicationBoundary | undefined;
let serial = 0;

/** A stub pipeline: the run says what it settled, and nothing calls a model. */
class StubRunner {
  run(episodeId: string): Promise<ReflectionRun> {
    return Promise.resolve({
      episodeId,
      status: 'completed',
      applied: true,
      summary: {
        episodeId,
        durationMs: 1,
        counts: {},
        skippedStages: [],
        stages: STAGES.map((name) => ({
          name,
          status: 'ok' as const,
          summary: 'stub pass',
          durationMs: 1,
        })),
      },
    });
  }
}

function payload(marker: string): Record<string, unknown> {
  return { observations: [`the sync keyed on id_slug ${marker}`] };
}

function integrateJobs(episodeId: string): number {
  return listReflectionJobs(store.db).filter(
    (job) => job.jobType === 'integrate' && job.episodeId === episodeId,
  ).length;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-converted-writers-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, {
    embedDimension: EMBED_DIMENSION,
  });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    boundary: ({ boundary }) => {
      expect(store.db.inTransaction).toBe(false);
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error(`interrupted at ${boundary}`);
      }
    },
  });
  await coordinator.initialize();
  publishPipelineReadinessPolicy(
    store.db,
    STAGES.map((name) => ({ name, run: () => Promise.resolve({ status: 'ok', summary: '' }) })),
    NOW,
  );
  intake = {
    driver: substrate.harness.driver,
    db: store.db,
    sessions: new SessionManager(substrate.harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    publications: coordinator,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };
}, 120_000);

beforeEach(() => {
  failAt = undefined;
  serial += 1;
});

afterEach(async () => {
  failAt = undefined;
  await coordinator.recover();
  // Each case owns its own queue: a row an earlier case left would be claimed by the next
  // worker and would spend that case's single injected interruption on somebody else's job.
  store.db.prepare('DELETE FROM reflection_queue').run();
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

async function accept(): Promise<string> {
  const marker = `review-${serial}`;
  return (
    await handleReflection(intake, payload(marker), { identity: `session-${marker}`, now: NOW })
  ).episode_id;
}
async function runWorker(runner: { run(id: string): Promise<ReflectionRun> }): Promise<void> {
  const worker = new ReflectionWorker(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: batteryEmbedder,
      runner,
      logger: intake.logger,
      publications: coordinator,
      resolver: new EvidenceResolver({
        driver: substrate.harness.driver,
        db: store.db,
        logger: intake.logger,
      }),
    },
    { workerCount: 1, retryBaseMs: 60000 },
  );
  try {
    await worker.start();
    await worker.whenIdle();
  } finally {
    await worker.stop();
  }
}

it('recovers a service completion through the installed command handler set', async () => {
  await accept();
  failAt = 'before_ack';
  await runWorker(new StubRunner());
  const command = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger: intake.logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
  });
  await command.initialize();
  await expect(
    handleReflection({ ...intake, publications: command }, payload(`new-${serial}`), {
      identity: `new-${serial}`,
      now: NOW,
    }),
  ).resolves.toHaveProperty('episode_id');
  expect(command.hasPending()).toBe(false);
});
it('still requires the outstanding queue-ack fix after shared-handler recovery', async () => {
  const id = await accept();
  failAt = 'before_ack';
  await runWorker(new StubRunner());
  expect(integrateJobs(id)).toBe(1);
  expect((await coordinator.recover())?.status).toBe('acknowledged');
  expect(integrateJobs(id)).toBe(0);
});
