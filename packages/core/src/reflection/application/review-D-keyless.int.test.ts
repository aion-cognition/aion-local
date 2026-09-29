import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { ReflectionOrchestrator } from './orchestrator.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { CognitiveExtractionStage } from './stages/cognitive.js';
import { EntityExtractionStage } from './stages/entities.js';
import { activatedCoordinator } from './test-support/publication-substrate.fixture.js';
import { ReflectionWorker } from './worker.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { GenerationUnavailableError } from '../../infrastructure/providers/errors.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  getReflectionJob,
  listReflectionJobs,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { SessionManager } from '../../session/session-manager.js';

let harness: Neo4jHarness;
let dir: string;
let store: SqliteStore;
let publications: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
const stages = [new EntityExtractionStage(), new CognitiveExtractionStage()];
let serial = 0;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dir = mkdtempSync(join(tmpdir(), 'aion-D-keyless-review-'));
  store = new SqliteStore({ filePath: join(dir, 'store.sqlite') });
  await runGraphMigrations(harness.driver, store.db, { embedDimension: 3 });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Review' });
  const logger = openLogger({ filePath: join(dir, 'test.jsonl'), level: 'fatal' });
  publications = await activatedCoordinator(
    { driver: harness.driver, db: store.db, logger },
    'D-keyless',
  );
  publishPipelineReadinessPolicy(store.db, stages, new Date());
  intake = {
    driver: harness.driver,
    db: store.db,
    logger,
    publications,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    lanes: new LaneAssigner(DEFAULTS.lanes),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };
}, 120000);

afterEach(() => {
  // The next case owns a fresh queue; source records remain for the real graph readers.
  store.db.prepare('DELETE FROM reflection_queue').run();
});

afterAll(async () => {
  store.close();
  await stopNeo4jHarness(harness);
  rmSync(dir, { recursive: true, force: true });
});

async function runCapture(failure: 'keyless' | 'ordinary') {
  serial += 1;
  const source = await handleReflection(
    intake,
    {
      observations: [
        'Priya chose Neo4j for the physician scheduling graph because cross-team dependency traversal matters.',
      ],
      summary: 'An explicit architecture decision with a named owner',
    },
    { identity: `D-keyless-${serial}` },
  );
  const job = listReflectionJobs(store.db).find(
    (row) => row.episodeId === source.episode_id && row.jobType === 'integrate',
  );
  if (job === undefined) {
    throw new Error('intake did not enqueue integration');
  }
  let generated = 0;
  let embedded = 0;
  const provider: Provider = {
    embed: async (texts) => {
      embedded += texts.length;
      return texts.map(() => [0.2, 0.4, 0.8]);
    },
    generate: async (request) => {
      generated += 1;
      if (failure === 'keyless') {
        throw new GenerationUnavailableError(request.surface ?? 'review');
      }
      throw new Error('ordinary provider transport failure');
    },
  };
  const runner = new ReflectionOrchestrator(
    {
      driver: harness.driver,
      db: store.db,
      provider,
      logger: intake.logger,
      publications,
    },
    stages,
  );
  const worker = new ReflectionWorker(
    {
      driver: harness.driver,
      db: store.db,
      provider,
      runner,
      logger: intake.logger,
      publications,
      resolver: new EvidenceResolver({
        driver: harness.driver,
        db: store.db,
        logger: intake.logger,
      }),
    },
    { workerCount: 1, retryBaseMs: 60000, breakerCooldownMs: 60000 },
  );
  try {
    await worker.start();
    await worker.whenIdle();
  } finally {
    await worker.stop();
  }
  const remaining = getReflectionJob(store.db, job.id);
  console.log(JSON.stringify({ failure, generated, embedded, remaining }));
  return { remaining, generated, embedded };
}

it('leaves real extraction work unattempted when the configured generation backend has no key', async () => {
  const result = await runCapture('keyless');
  expect(result.embedded).toBeGreaterThan(0);
  expect(result.remaining).toBeDefined();
  expect(result.remaining?.attempts).toBe(0);
  expect(result.remaining?.claimedBy).toBeNull();
}, 60000);

it('still charges an ordinary provider failure against the retry bound', async () => {
  const result = await runCapture('ordinary');
  expect(result.generated).toBeGreaterThan(0);
  expect(result.remaining?.attempts).toBe(1);
}, 60000);
