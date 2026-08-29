import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { contentVectors, vectorSeeds } from '../../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../../infrastructure/providers/ollama-provider.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { listSupersessionProposals } from '../../../infrastructure/sqlite/supersession-proposals.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { StageContext } from '../../domain/stage.js';
import { ReflectionDispatch } from '../dispatch.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';
import { SupersessionStage } from './supersession.js';

/**
 * Three pairs of contradicting decisions on three unrelated subjects, each pair split across
 * a prior episode and a later one. Intake and the cognitive-node writes are deterministic
 * (embedding only, no generation), so the model's part in this file is exactly the judgment
 * under test.
 */
const PAIRS = [
  {
    key: 'queue',
    prior: 'Queue writes stay inside the main Postgres transaction.',
    next: 'Queue writes move to a separate SQLite database, out of the Postgres transaction.',
  },
  {
    key: 'deploy',
    prior: 'Production deploys go out every Friday afternoon.',
    next: 'Production deploys never go out on a Friday; they move to Tuesday mornings.',
  },
  {
    key: 'auth',
    prior: 'Session tokens are stored in browser local storage.',
    next: 'Session tokens are never stored in local storage; they live in an httpOnly cookie.',
  },
] as const;

type SeededPair = {
  readonly priorId: string;
  readonly nextId: string;
  readonly nextEpisodeId: string;
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let ollama: OllamaProvider;
const pairs = new Map<string, SeededPair>();

function ollamaProvider(): OllamaProvider {
  return new OllamaProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });
}

/** Answers every judgment the same way, so the threshold split is the only variable. */
function stubProvider(confidence: number, calls: StructuredRequest[]): Provider {
  return {
    embed: async () => [],
    generate: async (req: StructuredRequest) => {
      calls.push(req);
      return { contradicts: true, confidence, rationale: 'the later statement reverses the earlier one' };
    },
  };
}

async function contextFor(episodeId: string, provider: Provider): Promise<StageContext> {
  const episode = await loadEpisodeContext(harness.driver, episodeId);
  expect(episode).toBeDefined();
  return {
    driver: harness.driver,
    db,
    provider,
    episodeId,
    episode: episode!,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: new Date(),
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-supersession-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
  ollama = ollamaProvider();

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: ollama,
    dispatch: new ReflectionDispatch(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
  };

  for (const pair of PAIRS) {
    const priorEpisode = await handleReflection(
      intake,
      { turns: [{ role: 'assistant', text: pair.prior }], summary: `${pair.key} decision` },
      { identity: `mcp-supersession-${pair.key}-prior` },
    );
    const nextEpisode = await handleReflection(
      intake,
      { turns: [{ role: 'assistant', text: pair.next }], summary: `${pair.key} decision revised` },
      { identity: `mcp-supersession-${pair.key}-next` },
    );

    const [priorVector, nextVector] = await ollama.embed([pair.prior, pair.next]);
    const now = new Date();
    const prior = await writeCognitiveNode(harness.driver, {
      episodeId: priorEpisode.episode_id,
      label: 'Decision',
      text: pair.prior,
      contentVector: priorVector,
      now,
    });
    const next = await writeCognitiveNode(harness.driver, {
      episodeId: nextEpisode.episode_id,
      label: 'Decision',
      text: pair.next,
      contentVector: nextVector,
      now,
    });

    pairs.set(pair.key, {
      priorId: prior.node.id,
      nextId: next.node.id,
      nextEpisodeId: nextEpisode.episode_id,
    });
  }
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SupersessionStage against a live graph', () => {
  it('judges the closest current neighbour of the same kind through live Ollama', async () => {
    const pair = pairs.get('queue')!;
    const calls: StructuredRequest[] = [];
    const provider: Provider = {
      embed: async (texts) => ollama.embed(texts),
      generate: async (req: StructuredRequest) => {
        calls.push(req);
        return ollama.generate(req);
      },
    };

    const ctx = await contextFor(pair.nextEpisodeId, provider);
    const outcome = await new SupersessionStage({
      model: DEFAULTS.models.reflect,
      maxNeighbors: 1,
    }).run(ctx);

    expect(outcome.status).toBe('ok');
    // The KNN leg is what this asserts: real 768-dim embeddings of two contradicting
    // decisions land inside the neighbour threshold, so a judgment is spent at all.
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain(PAIRS[0].prior);
    expect(prompt).toContain(PAIRS[0].next);
  }, 180_000);

  it('closes the old node with lineage when the judgment clears the threshold', async () => {
    const pair = pairs.get('deploy')!;
    const calls: StructuredRequest[] = [];

    const ctx = await contextFor(pair.nextEpisodeId, stubProvider(0.95, calls));
    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(ctx);

    expect(calls).toHaveLength(1);
    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.supersessions).toBe(1);

    const [vector] = await contentVectors(harness.driver, {
      ids: [pair.nextId],
      mode: withCurrency(),
    });
    expect(vector).toBeDefined();

    // Currency-aware, not currency-filtered: the closed decision still comes back, marked.
    const hits = await vectorSeeds(harness.driver, {
      vector: vector!.vector,
      limit: 25,
      mode: withCurrency(),
    });
    const closed = hits.find((hit) => hit.id === pair.priorId);
    const current = hits.find((hit) => hit.id === pair.nextId);

    expect(closed?.currency).toBe('superseded');
    expect(closed?.supersededBy?.id).toBe(pair.nextId);
    expect(current?.currency).toBe('current');
  }, 180_000);

  it('records a proposal and leaves the graph untouched below the threshold', async () => {
    const pair = pairs.get('auth')!;
    const calls: StructuredRequest[] = [];

    const ctx = await contextFor(pair.nextEpisodeId, stubProvider(0.6, calls));
    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(ctx);

    expect(calls).toHaveLength(1);
    expect(outcome.counts?.supersessionProposals).toBe(1);

    const proposal = listSupersessionProposals(db).find((row) => row.oldId === pair.priorId);
    expect(proposal).toMatchObject({
      newId: pair.nextId,
      confidence: 0.6,
      episodeId: pair.nextEpisodeId,
      resolvedAt: null,
    });

    const hits = await vectorSeeds(harness.driver, {
      vector: (await contentVectors(harness.driver, { ids: [pair.nextId], mode: withCurrency() }))[0]!
        .vector,
      limit: 25,
      mode: withCurrency(),
    });
    expect(hits.find((hit) => hit.id === pair.priorId)?.currency).toBe('current');
  }, 180_000);
});
