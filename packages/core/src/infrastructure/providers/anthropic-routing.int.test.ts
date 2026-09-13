import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GenerationUnavailableError } from './errors.js';
import { ProviderRouter, type GenerationEvent } from './role-provider.js';
import { resolveProviderRouting } from './routing.js';
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
import { activatedCoordinator } from '../../reflection/application/test-support/publication-substrate.fixture.js';
import { directIntakePublisher } from '../../reflection/test-support/direct-intake.fixture.js';
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
import type { PublicationCoordinator } from '../publication/coordinator.js';
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
let publications: PublicationCoordinator;

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
  // Ahead of `directIntakePublisher`, which inserts a pairing row already marked initialized so
  // it can skip the protocol: a coordinator built after it finds a guard node nothing minted.
  publications = await activatedCoordinator(
    {
      driver: harness.driver,
      db,
      logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    },
    'anthropic-routing',
  );
  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications: directIntakePublisher(harness.driver, db),
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

    expect(routing.keyPresent).toBe(true);
    expect(routing.roles.cue).toEqual({
      role: 'cue',
      model: DEFAULTS.anthropic.model,
      available: true,
    });
    expect(routing.roles.reflect).toEqual({
      role: 'reflect',
      model: DEFAULTS.anthropic.model,
      available: true,
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
        publications,
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
  it('marks every role unavailable rather than routing it somewhere else', () => {
    const routing = resolveProviderRouting(config(''));

    expect(routing.keyPresent).toBe(false);
    expect(routing.roles.cue).toEqual({
      role: 'cue',
      model: DEFAULTS.anthropic.model,
      available: false,
    });
    expect(routing.roles.reflect).toEqual({
      role: 'reflect',
      model: DEFAULTS.anthropic.model,
      available: false,
    });
  });

  it('refuses a generation by name, and counts it as no generation at all', async () => {
    const keyless = newRouter('');
    const before = events.length;

    await expect(
      keyless.forRole('cue').generate({
        surface: 'cues',
        model: DEFAULTS.anthropic.model,
        messages: [{ role: 'user', content: 'Answer with {"ok": true} and nothing else.' }],
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        think: false,
      }),
    ).rejects.toBeInstanceOf(GenerationUnavailableError);

    // A substrate that never called anything has no failure rate.
    expect(events.slice(before)).toEqual([]);
  }, 180_000);

  it('still embeds locally with no key, because the vector space is not a route', async () => {
    const keyless = newRouter('');

    const [vector] = await keyless.embedder.embed(['an episode summary']);

    expect(vector).toHaveLength(DEFAULTS.models.embedDimension);
  }, 180_000);
});
