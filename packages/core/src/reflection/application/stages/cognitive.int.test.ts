import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CognitiveExtractionStage } from './cognitive.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import {
  BITEMPORAL_PROPERTIES,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
  TEMPORAL_CLASS_PROPERTY,
  VALID_HORIZON_PROPERTY,
} from '../../../infrastructure/graph/claim-key-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { ENTITY_MENTION_TYPE } from '../../../infrastructure/graph/entity-queries.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import {
  contentVectors,
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  escapeLuceneQuery,
  fulltextSeeds,
  vectorSeeds,
} from '../../../infrastructure/graph/seed-queries.js';
import { findEpisodeCognitiveNodes } from '../../../infrastructure/graph/semantic-relationship-queries.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { fromGraphDateTime } from '../../../infrastructure/graph/values.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { SessionManager } from '../../../session/session-manager.js';
import { readingHorizon } from '../../domain/claim-key.js';
import { foldName } from '../../domain/name-fold.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';

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
  summary:
    'decided to split the queue database from the main transaction and captured the idempotency insight',
};

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

/** The episode clock a keyed claim's horizon counts from, deliberately behind the write clock. */
const KEYED_OCCURRED_AT = new Date('2026-08-30T08:00:00.000Z');

const KEYED_NOW = new Date('2026-09-01T10:00:00.000Z');

/** The real embedder behind a fixed extraction, so one test asserts the key and not the model. */
function scriptedProvider(nodes: unknown): Provider {
  const real = provider();
  return {
    embed: (texts) => real.embed(texts),
    generate: async () => nodes,
  };
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
    provider: provider(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
  };

  const stored = await handleReflection(intake, PAYLOAD, { identity: SESSION_IDENTITY });
  episodeId = stored.episode_id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('CognitiveExtractionStage against a live graph and a live model', () => {
  it('extracts Decision/Insight nodes findable by both content_vec_idx and content_fts', async () => {
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
      occurredAt: new Date(),
      pipelineVersion: PIPELINE_VERSION,
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
      provider: provider(),
      logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
      acceptHookCapture: true,
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
      provider: provider(),
      episodeId: lightEpisodeId,
      episode,
      logger: intake.logger,
      now: new Date(),
      occurredAt: new Date(),
      pipelineVersion: PIPELINE_VERSION,
    };

    const outcome = await new CognitiveExtractionStage({ model: DEFAULTS.models.reflect }).run(ctx);

    expect(outcome.status).not.toBe('failed');
    const nodes = await findEpisodeCognitiveNodes(harness.driver, lightEpisodeId);
    expect(nodes.filter((node) => node.label === 'Goal')).toHaveLength(0);
  }, 120_000);

  it('stores a resolved subject key and a horizon dated from the episode clock', async () => {
    const episode = await loadEpisodeContext(harness.driver, episodeId);
    if (episode === undefined) {
      throw new Error(`no episode ${episodeId}`);
    }

    const entityId = 'entity-reflection-queue';
    await writeStampedNode(harness.driver, {
      label: 'Entity',
      id: entityId,
      now: KEYED_NOW,
      occurredAt: KEYED_OCCURRED_AT,
      properties: {
        [ENTITY_NAME_PROPERTY]: 'Reflection Queue',
        [ENTITY_NAME_NORM_PROPERTY]: foldName('Reflection Queue'),
        type: 'system',
      },
    });
    await upsertEdge(harness.driver, {
      type: ENTITY_MENTION_TYPE,
      sourceId: episodeId,
      targetId: entityId,
      strength: 1,
      confidence: 1,
      signals: ['fixture'],
      provenance: ['fixture'],
      now: KEYED_NOW,
    });

    const ctx: StageContext = {
      driver: harness.driver,
      db,
      // The extraction is scripted so the key path is the only thing this asserts; embedding
      // still runs on the real model, because the node the graph stores carries a real vector.
      provider: scriptedProvider({
        nodes: [
          {
            type: 'Concept',
            text: 'the reflection queue holds 4,200 episodes this morning',
            subject_entity: 'reflection queue',
            aspect: 'Queued Episodes',
            temporal_class: 'reading',
          },
        ],
      }),
      episodeId,
      episode,
      logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
      now: KEYED_NOW,
      occurredAt: KEYED_OCCURRED_AT,
      pipelineVersion: PIPELINE_VERSION,
    };

    const outcome = await new CognitiveExtractionStage({
      model: DEFAULTS.models.reflect,
      readingHorizonDays: 30,
    }).run(ctx);

    expect(outcome.status).toBe('ok');
    const written = (await findEpisodeCognitiveNodes(harness.driver, episodeId)).find(
      (node) => node.label === 'Concept',
    );
    expect(written).toBeDefined();

    const properties = await nodeProperties(harness.driver, written!.id);
    expect(properties[CLAIM_SUBJECT_PROPERTY]).toBe(entityId);
    expect(properties[CLAIM_ASPECT_PROPERTY]).toBe('queued episodes');
    expect(properties[TEMPORAL_CLASS_PROPERTY]).toBe('reading');
    expect(fromGraphDateTime(properties[VALID_HORIZON_PROPERTY])).toEqual(
      readingHorizon(KEYED_OCCURRED_AT, 30),
    );
    // A horizon annotates at read and closes nothing, so the claim is still open on both clocks.
    expect(properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  }, 120_000);
});
