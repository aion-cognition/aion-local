import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { loadEpisodeContext } from '../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { findEpisodeEntities } from '../../infrastructure/graph/entity-queries.js';
import { findEpisodeCognitiveNodes } from '../../infrastructure/graph/semantic-relationship-queries.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import { SessionManager } from '../../session/session-manager.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry, isLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../domain/stage.js';
import { stageLedgerKey } from '../domain/stage.js';
import { CognitiveExtractionStage } from './stages/cognitive.js';
import { EntityExtractionStage } from './stages/entities.js';
import { ReflectionDispatch } from './dispatch.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { orchestratorLedgerKey, ReflectionOrchestrator } from './orchestrator.js';

const SESSION_IDENTITY = 'mcp-transport-session-orchestrator';

const PAYLOAD = {
  turns: [
    { role: 'user', text: 'ship the reflection worker', occurred_at: '2026-04-02T10:00:00Z' },
    { role: 'assistant', text: 'shipping it now', occurred_at: '2026-04-02T10:00:07Z' },
    { role: 'user', text: 'and gate the re-run', occurred_at: '2026-04-02T10:00:20Z' },
  ],
  observations: ['The ledger key is the whole idempotency story'],
  summary: 'shipping the reflection worker',
};

/** Rich enough to give a real entity-extraction and cognitive-extraction call something to name. */
const RETRY_PAYLOAD = {
  turns: [
    {
      role: 'user',
      text:
        'Priya Raman and I decided to keep Neo4j as the graph store instead of moving to Postgres, ' +
        'because the traversal queries are the whole point of the reflection pipeline.',
      occurred_at: '2026-08-28T11:00:00Z',
    },
    {
      role: 'assistant',
      text:
        'Understood. Priya Raman owns the Neo4j migration, and Aion extracts entities with Ollama ' +
        'running locally so the reflection pipeline stays self-hosted.',
      occurred_at: '2026-08-28T11:00:30Z',
    },
  ],
  observations: ['Keeping Neo4j means the entity graph stays queryable by traversal rather than by join'],
  summary: 'deciding to keep Neo4j over Postgres for the reflection pipeline',
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let episodeId: string;
let sessionId: string;
let entered: string[];
let contexts: StageContext[];
let intake: ReflectionIntakeDeps;

/** A fresh episode per test that runs a real pipeline, so per-stage ledger keys from one
 * test's stage names cannot skip another test's stage of the same name on a shared episode. */
async function freshEpisode(identitySuffix: string, payload = RETRY_PAYLOAD): Promise<string> {
  const stored = await handleReflection(intake, payload, {
    identity: `${SESSION_IDENTITY}-${identitySuffix}`,
  });
  return stored.episode_id;
}

function stage(name: string, outcome: StageOutcome): ReflectionStage {
  return {
    name,
    run: async (ctx: StageContext): Promise<StageOutcome> => {
      entered.push(name);
      contexts.push(ctx);
      return outcome;
    },
  };
}

function poisoned(name: string, message: string): ReflectionStage {
  return {
    name,
    run: async (): Promise<StageOutcome> => {
      entered.push(name);
      throw new Error(message);
    },
  };
}

function orchestrator(stages: readonly ReflectionStage[]): ReflectionOrchestrator {
  return new ReflectionOrchestrator(
    {
      driver: harness.driver,
      db,
      provider: new OllamaProvider({
        baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
        embedModel: DEFAULTS.models.embed,
      }),
      logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    },
    stages,
  );
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-orchestrator-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, {
    embedDimension: DEFAULTS.models.embedDimension,
  });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  intake = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: new OllamaProvider({
      baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      embedModel: DEFAULTS.models.embed,
    }),
    dispatch: new ReflectionDispatch(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };

  const stored = await handleReflection(intake, PAYLOAD, { identity: SESSION_IDENTITY });
  episodeId = stored.episode_id;
  sessionId = SESSION_IDENTITY;
}, 300_000);

beforeEach(() => {
  entered = [];
  contexts = [];
});

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reflection orchestrator against a live graph', () => {
  it('loads the episode and its turns in the order they were spoken', async () => {
    const episode = await loadEpisodeContext(harness.driver, episodeId);

    expect(episode?.id).toBe(episodeId);
    expect(episode?.sessionId).toBe(sessionId);
    expect(episode?.summary).toBe(PAYLOAD.summary);
    expect(episode?.occurredAt?.toISOString()).toBe('2026-04-02T10:00:00.000Z');
    expect(episode?.text).toContain('observation: The ledger key is the whole idempotency story');
    expect(episode?.turns.map((turn) => [turn.sequence, turn.role, turn.text])).toEqual([
      [0, 'user', 'ship the reflection worker'],
      [1, 'assistant', 'shipping it now'],
      [2, 'user', 'and gate the re-run'],
    ]);
    expect(episode?.turns[2]?.occurredAt?.toISOString()).toBe('2026-04-02T10:00:20.000Z');
  });

  it('returns nothing for an id no episode carries', async () => {
    expect(await loadEpisodeContext(harness.driver, 'episode-that-never-existed')).toBeUndefined();
  });

  it('leaves the ledger open when a stage throws, so the episode keeps its retry', async () => {
    // Its own episode: the per-stage ledger is keyed on (stage name, episode), and this
    // pipeline's stage names would otherwise collide with the next test's on a shared one.
    const throwingEpisodeId = await freshEpisode('throws');
    const pipeline = [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities', counts: { entities: 2 } }),
      poisoned('cognitive', 'the model returned nonsense'),
      stage('associations', { status: 'ok', summary: 'linked 3 pairs', counts: { associations: 3 } }),
    ];

    const run = await orchestrator(pipeline).run(throwingEpisodeId);

    // Isolation still holds: the stages after the throw ran and their counts stand.
    expect(entered).toEqual(['entities', 'cognitive', 'associations']);
    expect(run.status).toBe('completed');
    expect(run.summary.counts).toEqual({ entities: 2, associations: 3 });
    expect(run.applied).toBe(false);
    expect(getLedgerEntry(db, orchestratorLedgerKey(throwingEpisodeId))).toBeUndefined();
    entered = [];
  }, 60_000);

  it('enriches once: the run records its summary and the re-run is gated', async () => {
    const enrichEpisodeId = await freshEpisode('enrich');
    const pipeline = [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities', counts: { entities: 2 } }),
      stage('cognitive', { status: 'ok', summary: 'extracted 1 decision' }),
      stage('associations', { status: 'ok', summary: 'linked 3 pairs', counts: { associations: 3 } }),
    ];

    const first = await orchestrator(pipeline).run(enrichEpisodeId);

    expect(entered).toEqual(['entities', 'cognitive', 'associations']);
    expect(first.status).toBe('completed');
    expect(first.applied).toBe(true);
    expect(first.summary.counts).toEqual({ entities: 2, associations: 3 });
    expect(contexts[0]?.episode.turns).toHaveLength(2);

    const recorded = getLedgerEntry(db, orchestratorLedgerKey(enrichEpisodeId));
    expect(recorded?.summary).toEqual(JSON.parse(JSON.stringify(first.summary)));

    entered = [];
    const second = await orchestrator(pipeline).run(enrichEpisodeId);

    expect(second.status).toBe('already_applied');
    expect(second.applied).toBe(false);
    expect(entered).toEqual([]);
  }, 60_000);

  it(
    'a real entity and cognitive stage do not re-mint nodes when a later stage fails and the job retries',
    async () => {
      // Against a live graph: the two stages that actually write nodes run for real; the
      // stage after them fails so the run stays retryable, and the retry must not touch
      // the graph through the stages that already applied.
      const remintEpisodeId = await freshEpisode('remint');

      let entityCalls = 0;
      let cognitiveCalls = 0;
      const realEntities = new EntityExtractionStage();
      const realCognitive = new CognitiveExtractionStage();
      const spiedEntities: ReflectionStage = {
        name: realEntities.name,
        run: (ctx) => {
          entityCalls += 1;
          return realEntities.run(ctx);
        },
      };
      const spiedCognitive: ReflectionStage = {
        name: realCognitive.name,
        run: (ctx) => {
          cognitiveCalls += 1;
          return realCognitive.run(ctx);
        },
      };
      const flakySemantic = poisoned(
        'semantic-relationships',
        'semantic relationship call timed out: AbortError',
      );
      const pipeline = [spiedEntities, spiedCognitive, flakySemantic];

      const first = await orchestrator(pipeline).run(remintEpisodeId);

      expect(first.applied).toBe(false);
      expect(entityCalls).toBe(1);
      expect(cognitiveCalls).toBe(1);
      expect(first.summary.stages.map((s) => s.status)).toEqual(['ok', 'ok', 'failed']);

      const entitiesAfterFirst = await findEpisodeEntities(harness.driver, remintEpisodeId);
      const cognitiveAfterFirst = await findEpisodeCognitiveNodes(harness.driver, remintEpisodeId);
      expect(entitiesAfterFirst.length).toBeGreaterThan(0);
      expect(cognitiveAfterFirst.length).toBeGreaterThan(0);

      entered = [];
      const second = await orchestrator(pipeline).run(remintEpisodeId);

      // The stage that keeps failing retries; the two that already applied do not re-enter.
      expect(second.applied).toBe(false);
      expect(second.summary.skippedStages).toEqual(['entities', 'cognitive']);
      expect(entityCalls).toBe(1);
      expect(cognitiveCalls).toBe(1);
      expect(entered).toEqual(['semantic-relationships']);
      expect(isLedgerApplied(db, stageLedgerKey('entities', remintEpisodeId))).toBe(true);
      expect(isLedgerApplied(db, stageLedgerKey('cognitive', remintEpisodeId))).toBe(true);

      const entitiesAfterSecond = await findEpisodeEntities(harness.driver, remintEpisodeId);
      const cognitiveAfterSecond = await findEpisodeCognitiveNodes(harness.driver, remintEpisodeId);
      expect(entitiesAfterSecond.map((e) => e.id).sort()).toEqual(
        entitiesAfterFirst.map((e) => e.id).sort(),
      );
      expect(cognitiveAfterSecond.map((n) => n.id).sort()).toEqual(
        cognitiveAfterFirst.map((n) => n.id).sort(),
      );
    },
    300_000,
  );
});
