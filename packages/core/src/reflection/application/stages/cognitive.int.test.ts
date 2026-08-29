import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { contentVectors, escapeLuceneQuery, fulltextSeeds, vectorSeeds } from '../../../infrastructure/graph/seed-queries.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { findEpisodeCognitiveNodes } from '../../../infrastructure/graph/semantic-relationship-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../../infrastructure/providers/ollama-provider.js';
import { SessionManager } from '../../../session/session-manager.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { StageContext } from '../../domain/stage.js';
import { ReflectionDispatch } from '../dispatch.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';
import { CognitiveExtractionStage } from './cognitive.js';

const SESSION_IDENTITY = 'mcp-transport-session-cognitive';

const PAYLOAD = {
  turns: [
    {
      role: 'user',
      text: 'The reflection queue kept deadlocking against the main DB transaction.',
    },
    {
      role: 'assistant',
      text:
        'I decided to move queue writes to a separate SQLite database instead of sharing the ' +
        'Postgres transaction, because the shared transaction was the direct cause of the lock ' +
        'contention timeouts.',
    },
    {
      role: 'user',
      text: 'Good. What is the takeaway for next time?',
    },
    {
      role: 'assistant',
      text:
        'The key insight is that idempotency needs two separate levels, pipeline-level and ' +
        'operation-level, or a retried job creates duplicate work.',
    },
  ],
  summary: 'decided to split the queue database from the main transaction and captured the idempotency insight',
};

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

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-cognitive-int-'));
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
    lanes: new LaneAssigner(DEFAULTS.lanes),
  };

  const stored = await handleReflection(intake, PAYLOAD, { identity: SESSION_IDENTITY });
  episodeId = stored.episode_id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('CognitiveExtractionStage against a live graph and Ollama', () => {
  it('extracts Decision/Insight nodes findable by both content_vec_idx and content_fts', async () => {
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

    const stage = new CognitiveExtractionStage({ model: DEFAULTS.models.reflect });
    const outcome = await stage.run(ctx);

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.cognitive).toBeGreaterThan(0);

    const decisionOrInsight = ['decided', 'transaction', 'idempotency', 'insight'];
    const fulltextHits = (
      await Promise.all(
        decisionOrInsight.map((term) =>
          fulltextSeeds(harness.driver, {
            query: escapeLuceneQuery(term),
            limit: 10,
            mode: withCurrency(),
          }),
        ),
      )
    ).flat();

    const cognitiveHit = fulltextHits.find(
      (hit) => hit.labels.includes('Decision') || hit.labels.includes('Insight'),
    );
    expect(cognitiveHit).toBeDefined();

    // Self-match through the vector index: the node's own stored embedding is the query, so
    // it is the top hit if and only if `content_vec_idx` actually covers this node's label.
    const [vector] = await contentVectors(harness.driver, {
      ids: [cognitiveHit!.id],
      mode: withCurrency(),
    });
    expect(vector).toBeDefined();

    const vectorHits = await vectorSeeds(harness.driver, {
      vector: vector!.vector,
      limit: 5,
      mode: withCurrency(),
    });
    expect(vectorHits[0]?.id).toBe(cognitiveHit!.id);
  }, 120_000);

  it('mints no Goal from a decision-light closing episode, without failing the stage', async () => {
    const identity = 'mcp-transport-session-cognitive-decision-light';
    const payload = {
      turns: [
        { role: 'user', text: 'That covers everything on the list.' },
        { role: 'assistant', text: "Sounds good, that's a wrap for today." },
      ],
      summary: 'closed out the duplicate remittance investigation',
    };

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
      lanes: new LaneAssigner(DEFAULTS.lanes),
    };

    const stored = await handleReflection(intake, payload, { identity });
    const lightEpisodeId = stored.episode_id;
    const episode = await loadEpisodeContext(harness.driver, lightEpisodeId);
    if (episode === undefined) {
      throw new Error(`no episode ${lightEpisodeId}`);
    }

    const ctx: StageContext = {
      driver: harness.driver,
      db,
      provider: ollamaProvider(),
      episodeId: lightEpisodeId,
      episode,
      logger: intake.logger,
      now: new Date(),
    };

    const outcome = await new CognitiveExtractionStage({ model: DEFAULTS.models.reflect }).run(ctx);

    expect(outcome.status).not.toBe('failed');
    const nodes = await findEpisodeCognitiveNodes(harness.driver, lightEpisodeId);
    expect(nodes.filter((node) => node.label === 'Goal')).toHaveLength(0);
  }, 120_000);
});
