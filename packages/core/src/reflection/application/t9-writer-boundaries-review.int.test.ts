import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { reflectionCompletionPublication } from './completion-publication.js';
import { intakePublication } from './intake-publication.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { ReflectionOrchestrator, type ReflectionRun } from './orchestrator.js';
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
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { mergeExperienceProvenance } from '../../infrastructure/sqlite/experience-archive.js';
import { replaceProcessingGeneration } from '../../infrastructure/sqlite/generation-lifecycle.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  allocateProcessingGeneration,
  prepareInventorySkeleton,
  createSourceWork,
  readActiveGeneration,
} from '../../infrastructure/sqlite/processing-generations.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import { listReferenceBatches } from '../../infrastructure/sqlite/source-identity.js';
import { readGenerationWork } from '../../infrastructure/sqlite/source-readiness.js';
import { SessionManager } from '../../session/session-manager.js';

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
    handlers: [...PUBLICATION_HANDLERS, intakePublication, reflectionCompletionPublication],
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
    // Never called: intake embeds after acknowledgment and every case here asserts before that.
    provider: {
      embed: () => Promise.reject(new Error('no embedding in this battery')),
      generate: () => Promise.reject(new Error('no generation in this battery')),
    },
    publications: coordinator,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
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
      provider: intake.provider,
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
function states(id: string, generation: number): readonly string[] {
  return readGenerationWork(store.db, id, generation)
    .filter((row) => row.kind === 'stage')
    .map((row) => row.state);
}

it('does not settle a replacement generation from a run started under its predecessor', async () => {
  const id = await accept();
  await runWorker({
    async run(sourceId) {
      expect(readActiveGeneration(store.db, sourceId)?.processingGeneration).toBe(1);
      const replacement = allocateProcessingGeneration(store.db, {
        sourceId,
        policyRevision: 1,
        createdAt: NOW,
      });
      prepareInventorySkeleton(store.db, {
        sourceId,
        processingGeneration: replacement,
        stageNames: STAGES,
        dueAt: NOW,
      });
      replaceProcessingGeneration(store.db, { sourceId, replacementGeneration: replacement });
      return new StubRunner().run(sourceId);
    },
  });
  expect.soft(states(id, 2)).toEqual(['pending', 'pending']);
  expect.soft(integrateJobs(id)).toBe(1);
});

it('rejects a completion read before newly owed work advanced readiness', async () => {
  const id = await accept();
  await runWorker({
    async run(sourceId) {
      createSourceWork(store.db, {
        workId: `late-${serial}`,
        sourceId,
        processingGeneration: 1,
        kind: 'settlement',
        workKey: `late-${serial}`,
        dueAt: NOW,
      });
      return new StubRunner().run(sourceId);
    },
  });
  expect(states(id, 1)).toEqual(['pending', 'pending']);
});

it('recovers queue completion in the same acknowledgment as stage settlement', async () => {
  const id = await accept();
  failAt = 'before_ack';
  await runWorker(new StubRunner());
  expect(states(id, 1)).toEqual(['pending', 'pending']);
  expect(integrateJobs(id)).toBe(1);
  expect((await coordinator.recover())?.status).toBe('acknowledged');
  expect.soft(states(id, 1)).toEqual(['completed', 'completed']);
  expect.soft(integrateJobs(id)).toBe(0);
});

it('recovers typed stage outcomes after a run-key landed before completion was prepared', async () => {
  const id = await accept();
  const stages = STAGES.map((name) => ({
    name,
    run: async () => ({ status: 'ok' as const, summary: 'accepted pass' }),
  }));
  const runner = new ReflectionOrchestrator(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: intake.provider,
      logger: intake.logger,
    },
    stages,
  );
  expect((await runner.run(id, { now: NOW })).applied).toBe(true);
  expect(states(id, 1)).toEqual(['pending', 'pending']);
  await runWorker(runner);
  expect(states(id, 1)).toEqual(['completed', 'completed']);
});

it('lets another intake writer recover every operation its service can leave pending', async () => {
  const id = await accept();
  failAt = 'before_ack';
  await runWorker(new StubRunner());
  const commandCoordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger: intake.logger,
    handlers: [...PUBLICATION_HANDLERS, intakePublication],
  });
  await commandCoordinator.initialize();
  await expect(
    handleReflection({ ...intake, publications: commandCoordinator }, payload(`after-${serial}`), {
      identity: `after-${serial}`,
      now: NOW,
    }),
  ).resolves.toHaveProperty('episode_id');
  expect(integrateJobs(id)).toBe(0);
});

it('does not mark legacy reference repair applied without recording or materializing its statements', async () => {
  const id = await accept();
  mergeExperienceProvenance(store.db, id, { derived_from: ['legacy-target'] });
  const acceptedBefore = listReferenceBatches(store.db, id);
  await runWorker(new StubRunner());
  expect(listReferenceBatches(store.db, id)).toEqual(acceptedBefore);
  expect(getLedgerEntry(store.db, `stated-references:${id}`)).toBeUndefined();
});
