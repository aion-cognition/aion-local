import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProviderRouter, type GenerationEvent } from './role-provider.js';
import { resolveProviderRouting } from './routing.js';
import { ReflectionDispatch } from '../../reflection/application/dispatch.js';
import {
  handleReflection,
  type ReflectionIntakeDeps,
} from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { ReflectionOrchestrator } from '../../reflection/application/orchestrator.js';
import { AssociationInferenceStage } from '../../reflection/application/stages/associations.js';
import { CognitiveExtractionStage } from '../../reflection/application/stages/cognitive.js';
import { ContextVectorStage } from '../../reflection/application/stages/context-vectors.js';
import { EntityExtractionStage } from '../../reflection/application/stages/entities.js';
import { EntityDedupStage } from '../../reflection/application/stages/entity-dedup.js';
import { SemanticRelationshipStage } from '../../reflection/application/stages/semantic-relationships.js';
import { SessionManager } from '../../session/session-manager.js';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';
import { bootstrapBackbone } from '../graph/backbone.js';
import { findEpisodeEntities } from '../graph/entity-queries.js';
import { runGraphMigrations } from '../graph/migrations.js';
import { findEpisodeCognitiveNodes } from '../graph/semantic-relationship-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The routed provider against the two live backends: a real enrichment on the Anthropic route,
 * and the same router with the key taken away answering from Ollama. It lives beside the
 * routing code rather than beside the stages because what is under test is where the call
 * goes; the stages are the realistic load that proves it.
 *
 * The key is read from the environment and never written anywhere. With no key the remote half
 * skips and the local half still runs.
 */

const API_KEY = (process.env.AION_ANTHROPIC_API_KEY ?? '').trim();
const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MEMBER_NAME = 'Ryan Huber';

const PAYLOAD = {
  summary: 'choosing the graph store for the Aion reflection pipeline',
  turns: [
    {
      role: 'user',
      text: 'Priya Raman and I decided to keep Neo4j as the graph store instead of moving to Postgres, because the traversal queries are the whole point of the reflection pipeline.',
      occurred_at: '2026-08-29T09:00:00Z',
    },
    {
      role: 'assistant',
      text: 'Understood. Priya Raman owns the Neo4j migration, and Aion keeps extracting entities through the provider layer.',
      occurred_at: '2026-08-29T09:00:30Z',
    },
  ],
  observations: ['Traversal is the reason the graph store stays Neo4j'],
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let episodeId: string;
let events: GenerationEvent[];
let router: ProviderRouter;

function config(apiKey: string): Config {
  return {
    ...DEFAULTS,
    ollama: { ...DEFAULTS.ollama, url: OLLAMA_URL },
    anthropic: { ...DEFAULTS.anthropic, apiKey },
  };
}

function newRouter(apiKey: string): ProviderRouter {
  return new ProviderRouter({
    config: config(apiKey),
    onGeneration: (event) => events.push(event),
  });
}

beforeAll(async () => {
  events = [];
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-routing-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });

  router = newRouter(API_KEY);
  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    // Intake embeds and never generates, so this is the local model under either route.
    provider: router.forRole('reflect'),
    dispatch: new ReflectionDispatch(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };

  episodeId = (await handleReflection(intake, PAYLOAD, { identity: 'anthropic-routing' }))
    .episode_id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(API_KEY === '')('enrichment on the Anthropic route', () => {
  it('resolves both generation roles to the configured Anthropic model', () => {
    const routing = resolveProviderRouting(config(API_KEY));

    expect(routing.roles.cue).toMatchObject({ provider: 'anthropic', reason: 'key' });
    expect(routing.roles.reflect).toMatchObject({
      provider: 'anthropic',
      model: DEFAULTS.anthropic.model,
      reason: 'key',
    });
  });

  it('enriches a real episode end to end, with every generation leaving the machine', async () => {
    const provider = router.forRole('reflect');
    const orchestrator = new ReflectionOrchestrator(
      {
        driver: harness.driver,
        db,
        provider,
        logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
      },
      [
        new EntityExtractionStage(),
        new EntityDedupStage(),
        new AssociationInferenceStage(),
        new CognitiveExtractionStage(),
        new SemanticRelationshipStage(),
        new ContextVectorStage(),
      ],
    );

    const before = events.length;
    const run = await orchestrator.run(episodeId);

    expect(run.status).toBe('completed');
    expect(run.summary.stages.filter((stage) => stage.status === 'failed')).toEqual([]);
    expect((await findEpisodeEntities(harness.driver, episodeId)).length).toBeGreaterThan(0);
    expect((await findEpisodeCognitiveNodes(harness.driver, episodeId)).length).toBeGreaterThan(0);

    // The telemetry is the answer to "did that enrichment leave the machine".
    const generations = events.slice(before);
    expect(generations.length).toBeGreaterThan(0);
    for (const event of generations) {
      expect(event.provider).toBe('anthropic');
      expect(event.model).toBe(DEFAULTS.anthropic.model);
      expect(event.role).toBe('reflect');
    }
  }, 300_000);
});

describe('the same router with the key taken away', () => {
  it('resolves every role back to its local model without touching the disk', () => {
    const routing = resolveProviderRouting(config(''));

    expect(routing.roles.cue).toMatchObject({ provider: 'ollama', model: DEFAULTS.models.cue });
    expect(routing.roles.reflect).toMatchObject({
      provider: 'ollama',
      model: DEFAULTS.models.reflect,
    });
  });

  it('answers a live generation from Ollama, and the telemetry says so', async () => {
    const local = newRouter('');
    const before = events.length;

    const answer = await local.forRole('cue').generate({
      model: DEFAULTS.models.cue,
      messages: [{ role: 'user', content: 'Answer with {"ok": true} and nothing else.' }],
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      think: false,
    });

    expect(answer).toEqual({ ok: true });
    expect(events.slice(before)).toEqual([
      expect.objectContaining({
        role: 'cue',
        provider: 'ollama',
        model: DEFAULTS.models.cue,
        ok: true,
      }),
    ]);
  }, 180_000);
});
