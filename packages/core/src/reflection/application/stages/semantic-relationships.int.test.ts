import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CognitiveExtractionStage } from './cognitive.js';
import { EntityExtractionStage } from './entities.js';
import { SemanticRelationshipStage } from './semantic-relationships.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { fetchAdjacency } from '../../../infrastructure/graph/adjacency.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { SEMANTIC_RELATIONSHIP_METHOD } from '../../../infrastructure/graph/semantic-relationship-queries.js';
import {
  nodeProperties,
  relationshipsByProvenance,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  spreadActivation,
  type ActivationBudget,
  type AdjacencyFetch,
} from '../../../recall/domain/activation.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { StageContext } from '../../domain/stage.js';
import { ReflectionDispatch } from '../dispatch.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';

const SESSION_IDENTITY = 'mcp-transport-session-semantic-relationships';

/** Strong, unambiguous causal language, so a live model has a real edge to name. */
const PAYLOAD = {
  turns: [
    {
      role: 'user',
      text: 'The shared Postgres transaction caused the reflection queue to deadlock under load.',
    },
    {
      role: 'assistant',
      text:
        'Because the shared transaction was the direct cause of the lock contention, I decided ' +
        'to move the reflection queue onto a separate SQLite database. Moving the queue onto ' +
        'SQLite enabled the worker to retry a job without touching the Postgres transaction at all.',
    },
  ],
  summary: 'traced the deadlock to the shared Postgres transaction and moved the queue onto SQLite',
};

const DIRECTED_CAUSAL_TYPES = new Set(['CAUSES', 'ENABLES']);

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let episodeId: string;

function provider(): Provider {
  return testGenerationProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });
}

const BUDGET: ActivationBudget = {
  maxIterations: 100,
  decayFactor: DEFAULTS.activation.decayFactor,
  minActivation: DEFAULTS.activation.minActivation,
  maxNodesVisited: DEFAULTS.activation.maxNodesVisited,
  hubThreshold: DEFAULTS.activation.hubThreshold,
  maxHops: 1,
  associationStrength: DEFAULTS.recall.associationStrength,
  maxActivated: DEFAULTS.contextResonance.activationLimit,
};

const fetch: AdjacencyFetch = (request) =>
  fetchAdjacency(harness.driver, { ...request, mode: withCurrency() });

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-semantic-relationships-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: provider(),
    dispatch: new ReflectionDispatch(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };

  const stored = await handleReflection(intake, PAYLOAD, { identity: SESSION_IDENTITY });
  episodeId = stored.episode_id;

  // Entity and cognitive extraction populate the candidate set this stage reads; running
  // them first is production stage order, not a test-only shortcut.
  const episode = await loadEpisodeContext(harness.driver, episodeId);
  if (episode === undefined) {
    throw new Error(`no episode ${episodeId}`);
  }
  const setupCtx: StageContext = {
    driver: harness.driver,
    db,
    provider: provider(),
    episodeId,
    episode,
    logger: intake.logger,
    now: new Date(),
  };

  const entityOutcome = await new EntityExtractionStage({ model: DEFAULTS.models.reflect }).run(
    setupCtx,
  );
  expect(entityOutcome.status).toBe('ok');
  const cognitiveOutcome = await new CognitiveExtractionStage({
    model: DEFAULTS.models.reflect,
  }).run(setupCtx);
  expect(cognitiveOutcome.status).toBe('ok');
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SemanticRelationshipStage against a live graph and a live model', () => {
  // Whether the live 8B judges a sentence as CAUSES rather than RELATED_TO, and which way it
  // points the edge, is model judgment. The suite pins structure, never model output quality:
  // these two measurements live in the quality harness, and the mocked unit tests hold the
  // validation contract (quoted justification, endpoint existence, clamping).
  it.skip('proposes a causal edge that activation traverses with type-aware weight', async () => {
    const episode = await loadEpisodeContext(harness.driver, episodeId);
    expect(episode).toBeDefined();

    const ctx: StageContext = {
      driver: harness.driver,
      db,
      provider: provider(),
      episodeId,
      episode: episode!,
      logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
      now: new Date(),
    };

    const stage = new SemanticRelationshipStage({ model: DEFAULTS.models.reflect });
    const outcome = await stage.run(ctx);

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.relationships).toBeGreaterThan(0);

    const written = await relationshipsByProvenance(harness.driver, SEMANTIC_RELATIONSHIP_METHOD);
    const causal = written.find((edge) => DIRECTED_CAUSAL_TYPES.has(edge.type));
    expect(causal, `expected a CAUSES/ENABLES edge among ${JSON.stringify(written)}`).toBeDefined();

    const run = await spreadActivation(fetch, {
      seeds: [{ nodeId: causal!.sourceId }],
      budget: BUDGET,
    });

    const target = run.activated.find((node) => node.nodeId === causal!.targetId);
    expect(target).toBeDefined();
    expect(target?.pathSummary).toContain(`-[${causal!.type}]->`);
    // CAUSES carries 0.35, ENABLES 0.3 (recall/domain/activation-weights.ts,
    // MODEL_INFERRED_PENALTY applied); either way the edge propagates a type-specific
    // fraction of the seed's full activation, not the raw 1.0.
    expect(target?.score).toBeGreaterThan(0);
    expect(target?.score).toBeLessThan(1);
    // The edge is written with a quoted justification, stored as its rationale.
    expect(causal!.rationale).toBeDefined();
    expect(causal!.rationale?.length).toBeGreaterThan(0);

    // Direction, checked across every CAUSES/ENABLES edge this run wrote rather than only
    // the one `spreadActivation` happened to seed from: a live, sampling model proposes
    // several candidate edges of varying quality in one call, and what this stage guarantees
    // is that a correctly-directed edge is there to find, not that every edge it proposes is
    // one. The measured inversion put the effect entity on the source end and the cause
    // entity on the target end; guard against that shape on each edge.
    const causalEdges = written.filter((edge) => DIRECTED_CAUSAL_TYPES.has(edge.type));
    const directions = await Promise.all(
      causalEdges.map(async (edge) => {
        const source = await nodeProperties(harness.driver, edge.sourceId);
        const targetProps = await nodeProperties(harness.driver, edge.targetId);
        const sourceText = (
          (source.text as string | null) ??
          (source.name as string | null) ??
          ''
        ).toLowerCase();
        const targetText = (
          (targetProps.text as string | null) ??
          (targetProps.name as string | null) ??
          ''
        ).toLowerCase();
        const inverted = sourceText.includes('deadlock') && targetText.includes('transaction');
        return { type: edge.type, sourceText, targetText, inverted };
      }),
    );
    expect(
      directions.some((direction) => !direction.inverted),
      `every causal edge looked inverted: ${JSON.stringify(directions)}`,
    ).toBe(true);
  }, 120_000);

  it.skip('does not write CONTRADICTS on agreement restated in different words or on unrelated entities', async () => {
    const identity = 'mcp-transport-session-semantic-relationships-contradicts-bait';
    const payload = {
      turns: [
        {
          role: 'user',
          text:
            'We evaluated Redix as the queue but rejected it because it lacks compatibility ' +
            'with our existing Redis deployment.',
        },
        {
          role: 'assistant',
          text:
            'Right, Redix was rejected due to its lack of compatibility with Redis. Separately, ' +
            'the ingest service and the appeals service both read from the same Postgres database.',
        },
      ],
      summary:
        'rejected Redix for Redis incompatibility; noted the ingest and appeals services share Postgres',
    };

    const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
    const intake: ReflectionIntakeDeps = {
      driver: harness.driver,
      db,
      sessions: new SessionManager(harness.driver, {
        memberId: backbone.member.id,
        workspaceId: backbone.workspace.id,
      }),
      provider: provider(),
      dispatch: new ReflectionDispatch(),
      logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    };

    const stored = await handleReflection(intake, payload, { identity });
    const baitEpisodeId = stored.episode_id;
    const episode = await loadEpisodeContext(harness.driver, baitEpisodeId);
    if (episode === undefined) {
      throw new Error(`no episode ${baitEpisodeId}`);
    }
    const setupCtx: StageContext = {
      driver: harness.driver,
      db,
      provider: provider(),
      episodeId: baitEpisodeId,
      episode,
      logger: intake.logger,
      now: new Date(),
    };

    const entityOutcome = await new EntityExtractionStage({ model: DEFAULTS.models.reflect }).run(
      setupCtx,
    );
    expect(entityOutcome.status).toBe('ok');
    const cognitiveOutcome = await new CognitiveExtractionStage({
      model: DEFAULTS.models.reflect,
    }).run(setupCtx);
    expect(cognitiveOutcome.status).toBe('ok');

    const stage = new SemanticRelationshipStage({ model: DEFAULTS.models.reflect });
    const outcome = await stage.run(setupCtx);
    expect(outcome.status).toBe('ok');

    // Scoped by provenance across the whole test database rather than this episode alone:
    // the causal-prose test above writes the same provenance and asserts its own edges are
    // CAUSES/ENABLES, never CONTRADICTS, so a global zero is exactly what both tests expect.
    const written = await relationshipsByProvenance(harness.driver, SEMANTIC_RELATIONSHIP_METHOD);
    const contradicts = written.filter((edge) => edge.type === 'CONTRADICTS');
    const described = await Promise.all(
      contradicts.map(async (edge) => {
        const source = await nodeProperties(harness.driver, edge.sourceId);
        const target = await nodeProperties(harness.driver, edge.targetId);
        return {
          source: source.text ?? source.name,
          target: target.text ?? target.name,
          rationale: edge.rationale,
        };
      }),
    );
    expect(contradicts, `expected no CONTRADICTS; got ${JSON.stringify(described)}`).toHaveLength(
      0,
    );
  }, 120_000);
});
