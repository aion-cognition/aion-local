import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { completionBinding, reflectionCompletionPublication } from './completion-publication.js';
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
import { relationshipTypesBetween } from '../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { listStatedLinks } from '../../infrastructure/sqlite/evidence-links.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import { readGenerationWork } from '../../infrastructure/sqlite/source-readiness.js';
import { SessionManager } from '../../session/session-manager.js';
import { stageLedgerKey } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';

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
let beforeAck: (() => void) | undefined;

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
      if (boundary === 'before_ack' && beforeAck !== undefined) {
        const callback = beforeAck;
        beforeAck = undefined;
        callback();
      }
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
  beforeAck = undefined;
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
function states(id: string, generation: number): readonly string[] {
  return readGenerationWork(store.db, id, generation)
    .filter((row) => row.kind === 'stage')
    .map((row) => row.state);
}

it('does not reuse a pass after new stage continuation work lands in the same generation', async () => {
  const id = await accept();
  let calls = 0;
  const runner = new ReflectionOrchestrator(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: batteryEmbedder,
      logger: intake.logger,
    },
    STAGES.map((name) => ({
      name,
      run: async () => {
        if (name === STAGES[0]) {
          calls += 1;
          if (calls === 1) {
            const progress = await coordinator.publish({
              kind: 'reflection_completion',
              operationId: 'late-stage-work',
              payload: {
                sourceId: id,
                jobId: '',
                disposition: 'progress',
                ...completionBinding(store.db, id),
                stages: [
                  {
                    name,
                    status: 'skipped',
                    summary: 'late evidence needs another pair checked',
                    withheldWork: [
                      {
                        nodeIds: ['late-left', 'late-right'],
                        disposition: 'blocked',
                        reason: 'required_scope_missing',
                        addresses: [{ kind: 'id', id }],
                        revision: buildEvidenceRevision([]),
                      },
                    ],
                  },
                ],
              },
            });
            expect(progress.status).toBe('acknowledged');
          }
        }
        return { status: 'ok' as const, summary: 'the originally admitted pass' };
      },
    })),
  );
  await runWorker(runner);
  expect(states(id, 1)).toEqual(['pending', 'pending']);
  await runWorker(runner);
  const work = readGenerationWork(store.db, id, 1).find((row) => row.stageName === STAGES[0]);
  expect(calls > 1 || work?.state !== 'completed').toBe(true);
});
it('does not rerun an applied stage whose stored legacy outcome cannot be decoded', async () => {
  const id = await accept();
  markLedgerApplied(store.db, stageLedgerKey(PIPELINE_VERSION, STAGES[0]!, id), {
    legacyDialect: 'old writer',
    effectsRecorded: true,
  });
  let calls = 0;
  const runner = new ReflectionOrchestrator(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: batteryEmbedder,
      logger: intake.logger,
    },
    STAGES.map((name) => ({
      name,
      run: async () => {
        if (name === STAGES[0]) {
          calls += 1;
        }
        return { status: 'ok' as const, summary: 'a new pass' };
      },
    })),
  );
  await runWorker(runner);
  expect(calls).toBe(0);
});

it('retains a known reference across an interrupted intake preparation', async () => {
  const target = await accept();
  failAt = 'prepared';
  await expect(
    handleReflection(
      intake,
      {
        observations: ['interrupted referenced source'],
        provenance: { derived_from: [target] },
      },
      { identity: 'interrupted-ref-control', now: NOW },
    ),
  ).rejects.toThrow();
  const recovered = await coordinator.recover();
  expect(recovered?.status).toBe('acknowledged');
  const links = store.db
    .prepare(
      "SELECT l.from_id FROM evidence_links l JOIN evidence_link_versions v ON v.link_id=l.link_id JOIN publication_intents i ON i.operation_id=v.operation_id WHERE l.to_id=? AND l.kind='derived_from' AND v.known_from IS NOT NULL AND i.state='acknowledged'",
    )
    .all(target) as { from_id: string }[];
  expect(links).toHaveLength(1);
  expect(
    await relationshipTypesBetween(substrate.harness.driver, links[0]!.from_id, target),
  ).toContain('DERIVES_FROM');
  expect(await coordinator.recover()).toBeUndefined();
});
it('keeps a late reference whose publication starts at the completion acknowledgement boundary', async () => {
  const target = await handleReflection(intake, payload('late-target'), {
    identity: 'late-target',
    now: NOW,
  });
  const source = await handleReflection(intake, payload('last-boundary-source'), {
    identity: 'last-boundary-source',
    now: NOW,
  });
  // Only this source's integrate job participates in this race.
  store.db.prepare('DELETE FROM reflection_queue WHERE episode_id <> ?').run(source.episode_id);
  const sibling = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger: intake.logger,
    handlers: [...PUBLICATION_HANDLERS, intakePublication, reflectionCompletionPublication],
  });
  await sibling.initialize();
  let late: Promise<unknown> | undefined;
  let fired = false;
  beforeAck = () => {
    fired = true;
    late = handleReflection(
      { ...intake, publications: sibling },
      {
        ...payload('last-boundary-source'),
        provenance: { derived_from: [target.episode_id] },
      },
      { identity: 'last-boundary-source', now: NOW },
    );
  };
  const runner = new ReflectionOrchestrator(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: batteryEmbedder,
      logger: intake.logger,
    },
    STAGES.map((name) => ({
      name,
      run: async () => ({ status: 'ok' as const, summary: 'accepted pass' }),
    })),
  );
  await runWorker(runner);
  expect(fired).toBe(true);
  await late;
  expect(
    listStatedLinks(store.db, source.episode_id)
      .filter((link) => link.kind === 'derived_from' && link.knownFrom !== null)
      .map((link) => link.toId),
  ).toEqual([target.episode_id]);
  expect(
    await relationshipTypesBetween(substrate.harness.driver, source.episode_id, target.episode_id),
  ).toContain('DERIVES_FROM');
  expect(
    listReflectionJobs(store.db).filter(
      (job) => job.jobType === 'integrate' && job.episodeId === source.episode_id,
    ),
  ).toHaveLength(0);
});
