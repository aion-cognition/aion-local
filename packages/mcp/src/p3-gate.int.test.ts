import {
  bootstrapBackbone,
  CO_OCCURS_TYPE,
  CueCache,
  DEFAULTS,
  fetchAdjacency,
  findEpisodeCognitiveNodes,
  findEpisodeEntities,
  findPendingVectorNodes,
  findSessionNarratives,
  handleRecall,
  handleReflection,
  isLedgerApplied,
  LaneAssigner,
  listReflectionJobs,
  listReinforcementSignals,
  openLogger,
  openSqliteHandle,
  orchestratorLedgerKey,
  ReflectionDispatch,
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
  type RecallDeps,
  type ReflectionIntakeDeps,
  type SqliteHandle,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { testGenerationProvider } from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import type { MemoryPack } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { narrativeOptions, reflectionStages, workerOptions } from './bootstrap.js';

/**
 * The reflection pipeline's exit gate, assembled the way the service assembles itself: the
 * stage list, the worker options, and the narrative settings all come from `bootstrap.ts`,
 * so a pipeline wired only in this file could not pass. Everything below runs against a
 * live Ollama and a throwaway Neo4j; nothing here stands in for a model.
 *
 * Item 1 is the one this file exists for. Reflection is called, and nothing else: the worker
 * hears the dispatch signal, claims the row, and runs the pipeline on its own. No test drives
 * the orchestrator until item 2, whose whole subject is what a second run does.
 */

const MEMBER_NAME = 'Ryan Huber';
const WORK_SESSION = 'p3-gate-work';
const OUTAGE_SESSION = 'p3-gate-outage';
const READ_SESSION = 'p3-gate-read';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const RECALLED_AT = new Date('2026-08-28T18:00:00.000Z');

/** Named people, a project, tools, and a decision with a reason: entities and cognition in one episode. */
const WORK_PAYLOAD = {
  summary: 'settling the Aion reflection pipeline with Priya Raman',
  turns: [
    {
      role: 'user',
      text:
        'Priya Raman and I went through the Aion reflection pipeline this morning. We decided to keep Neo4j ' +
        'as the graph store instead of moving to Postgres, because the traversal queries are the whole point.',
      occurred_at: '2026-08-28T09:00:00Z',
    },
    {
      role: 'assistant',
      text:
        'Understood. Aion extracts entities with Ollama running locally, Priya Raman owns the Neo4j migration, ' +
        'and the goal is to have the reflection pipeline enriching episodes before the end of the quarter.',
      occurred_at: '2026-08-28T09:00:30Z',
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
let dispatch: ReflectionDispatch;
let worker: ReflectionWorker;
let config: Config;
let workEpisodeId: string;
let entitiesAfterRun: readonly EpisodeEntity[];

/** The graph is unreachable to this one, which is what an Ollama outage looks like from intake. */
const outageProvider: Provider = {
  embed: () => Promise.reject(new Error('ollama is unreachable')),
  generate: () => Promise.reject(new Error('ollama is unreachable')),
};

async function waitFor(
  label: string,
  deadlineMs: number,
  ready: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function intakeDeps(deps: {
  provider: Provider;
  dispatch: ReflectionDispatch;
}): ReflectionIntakeDeps {
  return {
    driver: harness.driver,
    db,
    sessions,
    provider: deps.provider,
    dispatch: deps.dispatch,
    logger,
    entropyThreshold: config.redaction.entropyThreshold,
    lanes: new LaneAssigner(config.lanes),
    workerMaxAttempts: config.operational.workerMaxAttempts,
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

function orchestrator(): ReflectionOrchestrator {
  return new ReflectionOrchestrator(
    { driver: harness.driver, db, provider, logger },
    reflectionStages(config),
  );
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

  dispatch = new ReflectionDispatch({
    onListenerError: (err, signal) => {
      logger.error({ err, jobId: signal.jobId }, 'reflection dispatch listener failed');
    },
  });
  worker = new ReflectionWorker(
    { driver: harness.driver, db, provider, dispatch, runner: orchestrator(), logger },
    workerOptions(config),
  );
  await worker.start();

  const stored = await handleReflection(intakeDeps({ provider, dispatch }), WORK_PAYLOAD, {
    identity: WORK_SESSION,
    now: NOW,
  });
  workEpisodeId = stored.episode_id;

  await waitFor('the signalled reflection run to reach the ledger', LEDGER_DEADLINE_MS, () =>
    Promise.resolve(isLedgerApplied(db, orchestratorLedgerKey(workEpisodeId))),
  );
  entitiesAfterRun = await findEpisodeEntities(harness.driver, workEpisodeId);
}, 600_000);

afterAll(async () => {
  await worker.stop();
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('gate item 1: one reflection call, no manual run', () => {
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

describe('gate item 2: the ledger blocks the re-run', () => {
  it('returns already_applied and writes nothing a second time', async () => {
    const entitiesBefore = entitiesAfterRun.length;
    const cognitiveBefore = (await cognitiveNodeIds(workEpisodeId)).length;

    const rerun = await orchestrator().run(workEpisodeId);

    expect(rerun.status).toBe('already_applied');
    expect(rerun.applied).toBe(false);
    expect(rerun.summary.stages).toHaveLength(0);
    expect((await findEpisodeEntities(harness.driver, workEpisodeId)).length).toBe(entitiesBefore);
    expect((await cognitiveNodeIds(workEpisodeId)).length).toBe(cognitiveBefore);
  });
});

describe('gate item 3: a closed session leaves a narrative', () => {
  it('writes one on the transport close hook the service registers', async () => {
    const closer = new SessionNarrativeCloser(
      { driver: harness.driver, provider, logger },
      narrativeOptions(config),
    );

    closer.onSessionClosed(WORK_SESSION);
    await closer.whenIdle();

    const narratives = await findSessionNarratives(harness.driver, WORK_SESSION);
    expect(narratives).toHaveLength(1);
    expect(narratives[0]?.version).toBe(1);
    expect(narratives[0]?.open).toBe(true);
    expect(narratives[0]?.coverageCount).toBeGreaterThan(0);
  }, 180_000);
});

describe('gate item 4: recall serves what reflection built', () => {
  let pack: MemoryPack;

  // One recall, read by both assertions: the pack is what the agent gets, and asking twice
  // would spend a second cue extraction proving nothing extra.
  beforeAll(async () => {
    pack = await handleRecall(
      recallDeps(),
      { query: RECALL_QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );
  }, 180_000);

  it('fills the facts and narratives buckets on a real recall', async () => {
    const factIds = (pack.facts ?? []).map((item) => item.id);
    const narrativeIds = (pack.narratives ?? []).map((item) => item.id);
    const extracted = new Set([
      ...entitiesAfterRun.map((entity) => entity.id),
      ...(await cognitiveNodeIds(workEpisodeId)),
    ]);
    const narratives = await findSessionNarratives(harness.driver, WORK_SESSION);

    expect(factIds.length).toBeGreaterThan(0);
    expect(factIds.some((id) => extracted.has(id))).toBe(true);
    expect(narrativeIds).toContain(narratives[0]?.id);

    // The pack the agent reads carries them too, not only the structured buckets.
    expect(pack.rendered_text).toContain('## Facts');
    expect(pack.rendered_text).toContain('## Narratives');
  });

  it('renders an entity as its name and the claim the episode made about it', () => {
    const byId = new Map(entitiesAfterRun.map((entity) => [entity.id, entity]));
    const entityItems = (pack.facts ?? []).filter((item) => byId.has(item.id));
    expect(entityItems.length).toBeGreaterThan(0);
    for (const item of entityItems) {
      const entity = byId.get(item.id);
      expect(item.content).toContain(entity?.name ?? '');
      expect(item.content).toContain(`(${entity?.type ?? ''})`);
    }
  });
});

describe('gate item 5: an inference outage defers, it never loses', () => {
  /** Its own dispatcher, so the running worker hears nothing: the queue row is the only record. */
  const silent = new ReflectionDispatch();
  let outageEpisodeId: string;

  it('stores and queues the episode with its vectors pending', async () => {
    const stored = await handleReflection(
      intakeDeps({ provider: outageProvider, dispatch: silent }),
      OUTAGE_PAYLOAD,
      {
        identity: OUTAGE_SESSION,
        now: NOW,
      },
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
        dispatch: new ReflectionDispatch(),
        runner: orchestrator(),
        logger,
      },
      workerOptions(config),
    );

    const drain = await recovered.start();
    await recovered.stop();

    expect(drain.vectored).toBeGreaterThan(0);
    expect(drain.ran).toBeGreaterThan(0);

    const stillPending = await findPendingVectorNodes(harness.driver, 100);
    expect(stillPending.map((node) => node.id)).not.toContain(outageEpisodeId);
    expect(isLedgerApplied(db, orchestratorLedgerKey(outageEpisodeId))).toBe(true);
  }, 600_000);
});
