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
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { replaceProcessingGeneration } from '../../infrastructure/sqlite/generation-lifecycle.js';
import {
  allocateProcessingGeneration,
  prepareInventorySkeleton,
} from '../../infrastructure/sqlite/processing-generations.js';
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

function payload(marker: string): Record<string, unknown> {
  return { observations: [`the sync keyed on id_slug ${marker}`] };
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

it('does not reuse a rejected generation pass on the next worker attempt', async () => {
  const id = await accept();
  let calls = 0;
  const runner = new ReflectionOrchestrator(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: intake.provider,
      logger: intake.logger,
    },
    STAGES.map((name) => ({
      name,
      run: async () => {
        if (name === STAGES[0]) {
          calls += 1;
          if (calls === 1) {
            const generation = allocateProcessingGeneration(store.db, {
              sourceId: id,
              policyRevision: 1,
              createdAt: NOW,
            });
            prepareInventorySkeleton(store.db, {
              sourceId: id,
              processingGeneration: generation,
              stageNames: STAGES,
              dueAt: NOW,
            });
            replaceProcessingGeneration(store.db, {
              sourceId: id,
              replacementGeneration: generation,
            });
          }
        }
        return { status: 'ok' as const, summary: 'accepted pass' };
      },
    })),
  );
  await runWorker(runner);
  expect(states(id, 2)).toEqual(['pending', 'pending']);
  await runWorker(runner);
  expect({
    falseCompletion: calls === 1 && states(id, 2).every((state) => state === 'completed'),
  }).toEqual({ falseCompletion: false });
});

it('recovers an implicit successful stage after a later stage failed', async () => {
  const id = await accept();
  let laterCalls = 0;
  let firstCalls = 0;
  const runner = new ReflectionOrchestrator(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: intake.provider,
      logger: intake.logger,
    },
    STAGES.map((name) => ({
      name,
      run: async () => {
        if (name === STAGES[0]) {
          firstCalls += 1;
        } else {
          laterCalls += 1;
          if (laterCalls === 1) {
            return { status: 'failed' as const, summary: 'transient unavailable' };
          }
        }
        return { status: 'ok' as const, summary: 'accepted pass' };
      },
    })),
  );
  await runWorker(runner);
  await runWorker(runner);
  expect.soft(firstCalls).toBe(1);
  expect.soft(laterCalls).toBe(2);
  expect(states(id, 1)).toEqual(['completed', 'completed']);
});

it('records blocked work from the actual worker before returning its failed job', async () => {
  const id = await accept();
  const blocked = {
    nodeIds: ['left', 'right'],
    disposition: 'blocked' as const,
    reason: 'required_source_suppressed',
    addresses: [{ kind: 'id' as const, id }],
    revision: buildEvidenceRevision([]),
  };
  const runner = new ReflectionOrchestrator(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: intake.provider,
      logger: intake.logger,
    },
    STAGES.map((name) => ({
      name,
      run: async () =>
        name === STAGES[0]
          ? { status: 'ok' as const, summary: 'partial pass', withheldWork: [blocked] }
          : { status: 'ok' as const, summary: 'accepted pass' },
    })),
  );
  await runWorker(runner);
  const row = store.db
    .prepare('SELECT continuation_json FROM source_work WHERE source_id=? AND stage_name=?')
    .get(id, STAGES[0]) as { continuation_json: string | null };
  expect(row.continuation_json === null ? null : JSON.parse(row.continuation_json)).toEqual({
    withheldWork: [blocked],
  });
});
