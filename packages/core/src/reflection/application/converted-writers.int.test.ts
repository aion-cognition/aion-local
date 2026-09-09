import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { reflectionCompletionPublication } from './completion-publication.js';
import { intakePublication } from './intake-publication.js';
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
import { episodeIdsInSession } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readScopeVersion } from '../../infrastructure/sqlite/evidence-scope.js';
import { readActiveGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import {
  listEvidenceAcknowledgments,
  SOURCE_INDEX_EFFECT,
} from '../../infrastructure/sqlite/source-lifecycle.js';
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

function indexJobs(episodeId: string): number {
  return listReflectionJobs(store.db).filter(
    (job) => job.jobType === 'source_index' && job.episodeId === episodeId,
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

it('takes a push through the coordinator and leaves the records the acceptance owes', async () => {
  const marker = `plain-${String(serial)}`;
  const result = await handleReflection(intake, payload(marker), {
    identity: `session-${marker}`,
    now: NOW,
  });

  expect(result.queued).toBe(true);
  expect(await episodeIdsInSession(substrate.harness.driver, `session-${marker}`)).toContain(
    result.episode_id,
  );
  expect(readSourceRecord(store.db, result.episode_id)?.verificationStatus).toBe('verified');
  const generation = readActiveGeneration(store.db, result.episode_id);
  expect(generation?.processingGeneration).toBe(1);
  expect(
    readGenerationWork(store.db, result.episode_id, 1)
      .filter((row) => row.kind === 'stage')
      .map((row) => row.stageName),
  ).toEqual(['cognitive', 'entities']);
});

it('resumes the ids it minted when the acknowledgment never ran', async () => {
  const marker = `crash-${String(serial)}`;
  failAt = 'before_ack';
  await expect(
    handleReflection(intake, payload(marker), { identity: `session-${marker}`, now: NOW }),
  ).rejects.toThrow();

  const recovered = await coordinator.recover();
  expect(recovered?.status).toBe('acknowledged');

  // The same push again answers with the id the interrupted attempt already minted, and mints
  // nothing second: the occurrence was decided durably before the graph was touched.
  const second = await handleReflection(intake, payload(marker), {
    identity: `session-${marker}`,
    now: NOW,
  });
  const episodes = await episodeIdsInSession(substrate.harness.driver, `session-${marker}`);
  expect(episodes).toEqual([second.episode_id]);
  expect(readActiveGeneration(store.db, second.episode_id)?.processingGeneration).toBe(1);
});

it('settles a finished run through the coordinator and clears its queue row', async () => {
  const marker = `settle-${String(serial)}`;
  const accepted = await handleReflection(intake, payload(marker), {
    identity: `session-${marker}`,
    now: NOW,
  });
  expect(integrateJobs(accepted.episode_id)).toBe(1);

  const worker = new ReflectionWorker(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: intake.provider,
      runner: new StubRunner(),
      logger: intake.logger,
      publications: coordinator,
      resolver: new EvidenceResolver({
        driver: substrate.harness.driver,
        db: store.db,
        logger: intake.logger,
      }),
    },
    { workerCount: 1 },
  );
  try {
    await worker.start();
    await worker.whenIdle();
  } finally {
    await worker.stop();
  }

  expect(integrateJobs(accepted.episode_id)).toBe(0);
  const stages = readGenerationWork(store.db, accepted.episode_id, 1).filter(
    (row) => row.kind === 'stage',
  );
  expect(stages.map((row) => row.state)).toEqual(['completed', 'completed']);
  expect(stages.map((row) => row.outcome?.reason)).toEqual([
    'accepted_pass_applied',
    'accepted_pass_applied',
  ]);
  expect(readActiveGeneration(store.db, accepted.episode_id)?.inventoryComplete).toBe(true);
});

it('advances the scopes a stated reference names, through the acceptance that carried it', async () => {
  const marker = `stated-${String(serial)}`;
  const first = await handleReflection(intake, payload(`${marker}-target`), {
    identity: `session-${marker}`,
    now: NOW,
  });
  const scope = { endpointId: first.episode_id, relationClass: 'sqlite:stated_correction:in' };
  // Nobody has stated anything about it, so the counter does not exist. An absent scope has no
  // token on purpose: minting one would turn "nobody has looked" into a claim.
  expect(readScopeVersion(store.db, scope)).toBeUndefined();

  await handleReflection(
    intake,
    { ...payload(marker), provenance: { supersedes: [first.episode_id] } },
    { identity: `session-${marker}`, now: NOW },
  );

  const advanced = readScopeVersion(store.db, scope);
  expect(advanced?.publishedRevision).toBe(1);
  expect(advanced?.pendingOperationId).toBeNull();
  // Advanced, and still uncounted: an acceptance states one thing and counts no population.
  expect(advanced?.censusStatus).toBe('unknown');
});

it('drains the source-index rows nothing else claims, and settles their obligation', async () => {
  const marker = `index-${String(serial)}`;
  const accepted = await handleReflection(intake, payload(marker), {
    identity: `session-${marker}`,
    now: NOW,
  });
  // Two rows per acceptance, and the pipeline's claim filter can only run one of them.
  expect(indexJobs(accepted.episode_id)).toBe(1);

  const worker = new ReflectionWorker(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: intake.provider,
      runner: new StubRunner(),
      logger: intake.logger,
      publications: coordinator,
      resolver: new EvidenceResolver({
        driver: substrate.harness.driver,
        db: store.db,
        logger: intake.logger,
      }),
    },
    { workerCount: 1 },
  );
  let drain;
  try {
    drain = await worker.start();
    await worker.whenIdle();
  } finally {
    await worker.stop();
  }

  expect(drain.indexed).toBeGreaterThan(0);
  expect(indexJobs(accepted.episode_id)).toBe(0);
  // The obligation the acceptance recorded is settled, which is what a removal decision reads.
  const settled = listEvidenceAcknowledgments(store.db, accepted.episode_id).find(
    (entry) => entry.effectKind === SOURCE_INDEX_EFFECT,
  );
  expect(settled?.state).toBe('completed');
});

it('leaves a run claimable when its completion is interrupted before the acknowledgment', async () => {
  const marker = `settle-crash-${String(serial)}`;
  const accepted = await handleReflection(intake, payload(marker), {
    identity: `session-${marker}`,
    now: NOW,
  });

  failAt = 'before_ack';
  const worker = new ReflectionWorker(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: intake.provider,
      runner: new StubRunner(),
      logger: intake.logger,
      publications: coordinator,
      resolver: new EvidenceResolver({
        driver: substrate.harness.driver,
        db: store.db,
        logger: intake.logger,
      }),
    },
    { workerCount: 1, retryBaseMs: 60_000 },
  );
  try {
    await worker.start();
    await worker.whenIdle();
    // Nothing settled and nothing completed: the interrupted attempt is durable and pending, and
    // the obligations are exactly where the run found them.
    expect(
      readGenerationWork(store.db, accepted.episode_id, 1)
        .filter((row) => row.kind === 'stage')
        .map((row) => row.state),
    ).toEqual(['pending', 'pending']);
    expect(integrateJobs(accepted.episode_id)).toBe(1);
  } finally {
    await worker.stop();
  }

  const recovered = await coordinator.recover();
  expect(recovered?.status).toBe('acknowledged');
  expect(
    readGenerationWork(store.db, accepted.episode_id, 1)
      .filter((row) => row.kind === 'stage')
      .map((row) => row.state),
  ).toEqual(['completed', 'completed']);
});
