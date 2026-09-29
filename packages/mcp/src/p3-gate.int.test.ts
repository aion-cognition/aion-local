import {
  bootstrapBackbone,
  CO_OCCURS_TYPE,
  CueCache,
  DEFAULTS,
  fetchAdjacency,
  findEpisodeCognitiveNodes,
  findEpisodeEntities,
  findPendingVectorNodes,
  handleRecall,
  handleReflection,
  INSTALLED_PUBLICATION_HANDLERS,
  isLedgerApplied,
  LaneAssigner,
  listReflectionJobs,
  listReinforcementSignals,
  NARRATIVE_PROPERTIES,
  openLogger,
  openSqliteHandle,
  orchestratorLedgerKey,
  PIPELINE_VERSION,
  PublicationCoordinator,
  ReflectionOrchestrator,
  ReflectionWorker,
  runGraphMigrations,
  SessionManager,
  SessionNarrativeCloser,
  withCurrency,
  type Config,
  type EpisodeEntity,
  type Logger,
  type Provider,
  type RecallCompletion,
  type RecallDeps,
  type ReflectionIntakeDeps,
  type ReflectionStage,
  type SqliteHandle,
  EvidenceResolver,
} from '@aion/core';
import { BITEMPORAL_PROPERTIES } from '@aion/core/infrastructure/graph/bitemporal.js';
import {
  narrativeIdsInSession,
  nodeProperties,
} from '@aion/core/infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { testGenerationProvider } from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import {
  directCompletionPublisher,
  directIntakePublisher,
  drainAcceptedVectors,
} from '@aion/core/reflection/test-support/direct-intake.fixture.js';
import type { MemoryPack } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { narrativeOptions, reflectionStages, workerOptions } from './bootstrap.js';
import { flatten, waitFor, REMOTE_JUDGE_ABSENT } from './gate/gate-substrate.fixture.js';

/**
 * The reflection pipeline's exit gate, assembled the way the service assembles itself: the
 * stage list, the worker options, and the narrative settings all come from `bootstrap.ts`,
 * so a pipeline wired only in this file could not pass. Everything below runs against a
 * live Ollama and a throwaway Neo4j; nothing here stands in for a model.
 *
 * Item 1 is the one this file exists for. Reflection is called, and nothing else: the worker
 * hears the enqueue wakeup, claims the row, and runs the pipeline on its own. No test drives
 * the orchestrator until item 2, whose whole subject is what a second run does.
 */

const MEMBER_NAME = 'Ryan Huber';
const WORK_SESSION = 'p3-gate-work';
const OUTAGE_SESSION = 'p3-gate-outage';
const READ_SESSION = 'p3-gate-read';
/** Its own session, so the shipped dedup does not withhold what the first read served. */
const RANKING_SESSION = 'p3-gate-read-ranking';

/**
 * Named people, a project, tools, and a decision with a reason: entities and cognition in one
 * episode. Every clock in this file is the wall clock, as in the service, and the turns carry no
 * timestamps of their own, so intake stamps the episode as it lands. A fixed date would fall
 * before the substrate's birth, which the coordinator stamps as it initializes: intake would cut
 * both turns, and the recall would judge currency at a moment before anything it reads was
 * written.
 */
const WORK_PAYLOAD = {
  summary: 'settling the Aion reflection pipeline with Priya Raman',
  turns: [
    {
      role: 'user',
      text:
        'Priya Raman and I went through the Aion reflection pipeline this morning. We decided to keep Neo4j ' +
        'as the graph store instead of moving to Postgres, because the traversal queries are the whole point.',
    },
    {
      role: 'assistant',
      text:
        'Understood. Aion extracts entities with Ollama running locally, Priya Raman owns the Neo4j migration, ' +
        'and the goal is to have the reflection pipeline enriching episodes before the end of the quarter.',
    },
  ],
  observations: [
    'Keeping Neo4j means the entity graph stays queryable by traversal rather than by join',
  ],
};

const OUTAGE_PAYLOAD = {
  summary: 'a note written while Ollama was down',
  observations: ['The Kubernetes upgrade is scheduled for the Berlin cluster next Tuesday'],
};

const RECALL_QUERY = 'why did we keep Neo4j for the Aion reflection pipeline';

const LEDGER_DEADLINE_MS = 300_000;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
let provider: Provider;
let worker: ReflectionWorker;
let config: Config;
let publications: PublicationCoordinator;
let workEpisodeId: string;
let entitiesAfterRun: readonly EpisodeEntity[];

/** The graph is unreachable to this one, which is what an Ollama outage looks like from intake. */
const outageProvider: Provider = {
  embed: () => Promise.reject(new Error('ollama is unreachable')),
  generate: () => Promise.reject(new Error('ollama is unreachable')),
};

function intakeDeps(deps: {
  provider: Provider;
  /** Omitted where the test wants the queue row to be the only record of the job. */
  onJobEnqueued?: () => void;
}): ReflectionIntakeDeps {
  return {
    driver: harness.driver,
    db,
    sessions,
    ...(deps.onJobEnqueued === undefined ? {} : { onJobEnqueued: deps.onJobEnqueued }),
    logger,
    entropyThreshold: config.redaction.entropyThreshold,
    lanes: new LaneAssigner(config.lanes),
    workerMaxAttempts: config.operational.workerMaxAttempts,
    publications: directIntakePublisher(harness.driver, db),
  };
}

function recallDeps(): RecallDeps {
  return {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config,
    cueCache: new CueCache(),
    logger,
  };
}

/**
 * With the publication coordinator the service passes: each extraction stage records its nodes'
 * sources through it and fails the run without it. The service also passes a judgment evidence
 * seam, and this does not, so a judging stage here reads its evidence for itself.
 */
function orchestrator(stages = reflectionStages(config)): ReflectionOrchestrator {
  return new ReflectionOrchestrator(
    { driver: harness.driver, db, provider, logger, publications },
    stages,
  );
}

/** The shipped stage list, each stage noting its name in `entered` before it runs. */
function recordingStages(entered: string[]): ReflectionStage[] {
  return reflectionStages(config).map((stage) => ({
    name: stage.name,
    ...(stage.describe === undefined ? {} : { describe: () => stage.describe?.() ?? {} }),
    run: (ctx) => {
      entered.push(stage.name);
      return stage.run(ctx);
    },
  }));
}

/** What reflection wrote for the work episode: its entities and its cognitive nodes. */
async function extractedIds(): Promise<Set<string>> {
  return new Set([
    ...entitiesAfterRun.map((entity) => entity.id),
    ...(await cognitiveNodeIds(workEpisodeId)),
  ]);
}

async function cognitiveNodeIds(episodeId: string): Promise<string[]> {
  const nodes = await findEpisodeCognitiveNodes(harness.driver, episodeId);
  return nodes.map((node) => node.id);
}

/** Association evidence read through the traversal adapter, not through Cypher written here. */
async function coOccurrenceCount(entityIds: readonly string[]): Promise<number> {
  const neighbors = await fetchAdjacency(harness.driver, {
    frontier: [...entityIds],
    visited: [],
    mode: withCurrency(),
    minStrength: DEFAULTS.recall.associationStrength,
    topK: DEFAULTS.recall.adjacencyTopK,
  });
  return neighbors.filter((neighbor) => neighbor.relationshipType === CO_OCCURS_TYPE).length;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-p3-gate-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  config = {
    ...DEFAULTS,
    ollama: { ...DEFAULTS.ollama, url: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434' },
  };

  await runGraphMigrations(harness.driver, db, { embedDimension: config.models.embedDimension });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  provider = testGenerationProvider({
    baseUrl: config.ollama.url,
    embedModel: config.models.embed,
  });
  // Gate item 3 narrates, and narration publishes. The intake publisher beside it is not a
  // substitute: the narrative path calls `recover()` and `publish()` on the coordinator.
  publications = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
  });
  await publications.initialize();

  worker = new ReflectionWorker(
    {
      driver: harness.driver,
      db,
      provider,
      runner: orchestrator(),
      logger,
      publications: directCompletionPublisher(harness.driver, db),
      resolver: new EvidenceResolver({
        driver: harness.driver,
        db,
        logger: { warn: () => undefined },
      }),
    },
    workerOptions(config),
  );
  await worker.start();

  const stored = await handleReflection(
    intakeDeps({
      provider,
      onJobEnqueued: () => {
        worker.wake();
      },
    }),
    WORK_PAYLOAD,
    { identity: WORK_SESSION },
  );
  expect(stored.pre_birth_trim).toBeUndefined();
  workEpisodeId = stored.episode_id;

  await waitFor('the signalled reflection run to reach the ledger', LEDGER_DEADLINE_MS, () =>
    Promise.resolve(isLedgerApplied(db, orchestratorLedgerKey(PIPELINE_VERSION, workEpisodeId))),
  );
  entitiesAfterRun = await findEpisodeEntities(harness.driver, workEpisodeId);
}, 600_000);

afterAll(async () => {
  await worker.stop();
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('gate item 1: one reflection call, no manual run', () => {
  it('leaves the episode carrying entities the model named', () => {
    expect(entitiesAfterRun.length).toBeGreaterThanOrEqual(2);
    for (const entity of entitiesAfterRun) {
      expect(entity.name.trim()).not.toBe('');
      expect(entity.nameNorm).toBe(entity.name.trim().replace(/\s+/g, ' ').toLowerCase());
    }
  });

  it('associates the entities that shared the episode', async () => {
    expect(await coOccurrenceCount(entitiesAfterRun.map((entity) => entity.id))).toBeGreaterThan(0);
  });

  it('extracts cognitive structure, not just names', async () => {
    expect((await cognitiveNodeIds(workEpisodeId)).length).toBeGreaterThan(0);
  });

  it('queues the co-extracted pairs for the plasticity flush', () => {
    const signals = listReinforcementSignals(db).filter(
      (signal) => signal.trigger === 'reflection:co-extraction',
    );
    expect(signals.length).toBeGreaterThan(0);
  });

  it('completes the job rather than leaving it claimed', () => {
    expect(listReflectionJobs(db).map((job) => job.payload)).not.toContainEqual({
      episode_id: workEpisodeId,
    });
  });
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('gate item 2: the ledger blocks the re-run', () => {
  it('returns already_applied, enters no stage, and writes nothing a second time', async () => {
    const entitiesBefore = entitiesAfterRun.length;
    const cognitiveBefore = (await cognitiveNodeIds(workEpisodeId)).length;
    const entered: string[] = [];

    const rerun = await orchestrator(recordingStages(entered)).run(workEpisodeId);

    expect(rerun.status).toBe('already_applied');
    expect(rerun.applied).toBe(false);
    // The answer hands back the outcomes the first run recorded, so its stage list is not empty.
    // Whether a stage ran again is read off the stages themselves.
    expect(entered).toEqual([]);
    expect((await findEpisodeEntities(harness.driver, workEpisodeId)).length).toBe(entitiesBefore);
    expect((await cognitiveNodeIds(workEpisodeId)).length).toBe(cognitiveBefore);
  });
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('gate item 3: a closed session leaves a narrative', () => {
  it('writes one on the transport close hook the service registers', async () => {
    const closer = new SessionNarrativeCloser(
      { driver: harness.driver, db, provider, logger, publications },
      narrativeOptions(config),
    );

    closer.onSessionClosed(WORK_SESSION);
    await closer.whenIdle();

    // The close seals the session's members into a chunk and publishes its first revision, which
    // derives from the session. `findSessionNarratives` reads only the legacy session family.
    const narratives = await narrativeIdsInSession(harness.driver, WORK_SESSION);
    expect(narratives).toHaveLength(1);
    const narrative = await nodeProperties(harness.driver, narratives[0] ?? '');
    expect(narrative[NARRATIVE_PROPERTIES.family]).toBe('chunk');
    expect(narrative[NARRATIVE_PROPERTIES.revisionNo]).toBe(1);
    expect(narrative[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(narrative[NARRATIVE_PROPERTIES.coverageCount]).toBeGreaterThan(0);
  }, 180_000);
});

/**
 * Under the shipped `assess` mode the recall model's selection is the pack, and a valid selection
 * is honored whatever it holds, none included. Which buckets it fills, and whether it picks an
 * entity over the decision that answers the question, is the model's judgment and gates nothing
 * here. The shipped read is held to what the host owns: retrieval reached what reflection built,
 * and nothing was served that retrieval did not offer. The bucket and rendering checks run on the
 * no-model `raw` read, where the existing ranking decides and the same assembly renders the pack.
 *
 * The raw read is not asked to serve the session narrative. Its vector leg takes its k nearest
 * before any predicate runs, and the narrative competes there with its own episode, turns and
 * decision, which restate the same sentence. Outside the k it arrives by recency alone and is
 * refused as unmeasured, so requiring it would gate on how near-duplicates split the slots. The
 * default read's `retrieved` is the narrative check.
 */
describe.skipIf(REMOTE_JUDGE_ABSENT)('gate item 4: recall serves what reflection built', () => {
  let pack: MemoryPack;
  let completion: RecallCompletion | undefined;
  let ranked: MemoryPack;

  beforeAll(async () => {
    // A chunk revision is published without a vector. The service embeds it at the next
    // maintenance `vector_backfill` tick or worker start, and until then the ranking refuses it as
    // unmeasured. Both reads drain first, so they read the settled state rather than that window.
    await drainAcceptedVectors(harness.driver, provider);
    pack = await handleRecall(
      {
        ...recallDeps(),
        onRecalled: (served) => {
          completion = served;
        },
      },
      { query: RECALL_QUERY },
      { identity: READ_SESSION },
    );
    ranked = await handleRecall(
      { ...recallDeps(), config: { ...config, recall: { ...config.recall, mode: 'raw' } } },
      { query: RECALL_QUERY },
      { identity: RANKING_SESSION },
    );
  }, 180_000);

  it('retrieves what reflection built, and serves nothing it did not retrieve', async () => {
    const retrieved = new Set(completion?.retrieved ?? []);
    const [narrativeId] = await narrativeIdsInSession(harness.driver, WORK_SESSION);

    expect([...(await extractedIds())].some((id) => retrieved.has(id))).toBe(true);
    expect(retrieved.has(narrativeId ?? '')).toBe(true);
    expect(flatten(pack).filter((item) => !retrieved.has(item.id))).toEqual([]);
  });

  it('fills the facts bucket from the ranking', async () => {
    const extracted = await extractedIds();
    const factIds = (ranked.facts ?? []).map((item) => item.id);

    expect(factIds.some((id) => extracted.has(id))).toBe(true);

    // The pack the agent reads carries them too, not only the structured bucket.
    expect(ranked.rendered_text).toContain('## Facts');
  });

  it('renders an entity as its name and the claim the episode made about it', () => {
    const byId = new Map(entitiesAfterRun.map((entity) => [entity.id, entity]));
    const entityItems = (ranked.facts ?? []).filter((item) => byId.has(item.id));
    expect(entityItems.length).toBeGreaterThan(0);
    for (const item of entityItems) {
      const entity = byId.get(item.id);
      expect(item.content).toContain(entity?.name ?? '');
      expect(item.content).toContain(`(${entity?.type ?? ''})`);
    }
  });
});

describe.skipIf(REMOTE_JUDGE_ABSENT)(
  'gate item 5: an inference outage defers, it never loses',
  () => {
    let outageEpisodeId: string;

    it('stores and queues the episode with its vectors pending', async () => {
      // No wakeup, so the running worker hears nothing: the queue row is the only record.
      const stored = await handleReflection(
        intakeDeps({ provider: outageProvider }),
        OUTAGE_PAYLOAD,
        { identity: OUTAGE_SESSION },
      );
      outageEpisodeId = stored.episode_id;

      expect(stored.queued).toBe(true);
      expect(listReflectionJobs(db).map((job) => job.payload)).toContainEqual({
        episode_id: outageEpisodeId,
      });

      const pending = await findPendingVectorNodes(harness.driver, 100);
      expect(pending.map((node) => node.id)).toContain(outageEpisodeId);
    });

    it('backfills the vectors and runs the queued job once Ollama answers again', async () => {
      const recovered = new ReflectionWorker(
        {
          driver: harness.driver,
          db,
          provider,
          runner: orchestrator(),
          logger,
          publications: directCompletionPublisher(harness.driver, db),
          resolver: new EvidenceResolver({
            driver: harness.driver,
            db,
            logger: { warn: () => undefined },
          }),
        },
        workerOptions(config),
      );

      const drain = await recovered.start();
      await recovered.stop();

      expect(drain.vectored).toBeGreaterThan(0);
      expect(drain.ran).toBeGreaterThan(0);

      const stillPending = await findPendingVectorNodes(harness.driver, 100);
      expect(stillPending.map((node) => node.id)).not.toContain(outageEpisodeId);
      expect(isLedgerApplied(db, orchestratorLedgerKey(PIPELINE_VERSION, outageEpisodeId))).toBe(
        true,
      );
    }, 600_000);
  },
);
