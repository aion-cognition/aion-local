import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { runRead } from '../../../infrastructure/graph/connection.js';
import { fetchAdjacency } from '../../../infrastructure/graph/adjacency.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { SEMANTIC_RELATIONSHIP_METHOD } from '../../../infrastructure/graph/semantic-relationship-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../../infrastructure/providers/ollama-provider.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { spreadActivation, type ActivationBudget, type AdjacencyFetch } from '../../../recall/domain/activation.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { StageContext } from '../../domain/stage.js';
import { ReflectionDispatch } from '../dispatch.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { CognitiveExtractionStage } from './cognitive.js';
import { EntityExtractionStage } from './entities.js';
import { SemanticRelationshipStage } from './semantic-relationships.js';

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

function ollamaProvider(): OllamaProvider {
  return new OllamaProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });
}

type WrittenRelationship = { readonly type: string; readonly sourceId: string; readonly targetId: string };

async function writtenSemanticRelationships(): Promise<WrittenRelationship[]> {
  return runRead(
    harness.driver,
    [
      'MATCH (a)-[r]->(b)',
      'WHERE $method IN r.provenance',
      'RETURN type(r) AS type, a.id AS sourceId, b.id AS targetId',
    ].join('\n'),
    { method: SEMANTIC_RELATIONSHIP_METHOD },
    (row) => ({ type: row.type as string, sourceId: row.sourceId as string, targetId: row.targetId as string }),
  );
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
    provider: ollamaProvider(),
    dispatch: new ReflectionDispatch(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
  };

  const stored = await handleReflection(intake, PAYLOAD, { identity: SESSION_IDENTITY });
  episodeId = stored.episode_id;

  // Entity and cognitive extraction populate the candidate set this stage reads; running
  // them first is production stage order (Algorithm 4 steps 3 and 6 precede step 7), not a
  // test-only shortcut.
  const episode = await loadEpisodeContext(harness.driver, episodeId);
  if (episode === undefined) {
    throw new Error(`no episode ${episodeId}`);
  }
  const setupCtx: StageContext = {
    driver: harness.driver,
    db,
    provider: ollamaProvider(),
    episodeId,
    episode,
    logger: intake.logger,
    now: new Date(),
  };

  const entityOutcome = await new EntityExtractionStage({ model: DEFAULTS.models.reflect }).run(setupCtx);
  expect(entityOutcome.status).toBe('ok');
  const cognitiveOutcome = await new CognitiveExtractionStage({ model: DEFAULTS.models.reflect }).run(setupCtx);
  expect(cognitiveOutcome.status).toBe('ok');
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SemanticRelationshipStage against a live graph and Ollama', () => {
  it('proposes a causal edge that activation traverses with type-aware weight', async () => {
    const episode = await loadEpisodeContext(harness.driver, episodeId);
    expect(episode).toBeDefined();

    const ctx: StageContext = {
      driver: harness.driver,
      db,
      provider: ollamaProvider(),
      episodeId,
      episode: episode!,
      logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
      now: new Date(),
    };

    const stage = new SemanticRelationshipStage({ model: DEFAULTS.models.reflect });
    const outcome = await stage.run(ctx);

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.relationships).toBeGreaterThan(0);

    const written = await writtenSemanticRelationships();
    const causal = written.find((edge) => DIRECTED_CAUSAL_TYPES.has(edge.type));
    expect(causal, `expected a CAUSES/ENABLES edge among ${JSON.stringify(written)}`).toBeDefined();

    const run = await spreadActivation(fetch, {
      seeds: [{ nodeId: causal!.sourceId }],
      budget: BUDGET,
    });

    const target = run.activated.find((node) => node.nodeId === causal!.targetId);
    expect(target).toBeDefined();
    expect(target?.pathSummary).toContain(`-[${causal!.type}]->`);
    // CAUSES carries 0.7, ENABLES 0.6 (recall/domain/activation.ts); either way the edge
    // propagates a type-specific fraction of the seed's full activation, not the raw 1.0.
    expect(target?.score).toBeGreaterThan(0);
    expect(target?.score).toBeLessThan(1);
  }, 120_000);
});
