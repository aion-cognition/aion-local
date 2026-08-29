import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import {
  linkEntityMentions,
  mergeEntities,
} from '../../../infrastructure/graph/entity-queries.js';
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
 * The exercise's contradiction battery against a live judge: one blatant reversal that must
 * produce a proposal and nothing else, and two baits that must produce nothing at all. Intake
 * and the cognitive-node writes are deterministic (embedding only, no generation), so the
 * model's part in this file is exactly the judgment under test.
 *
 * `subject` seeds an Entity both episodes mention, which is the leg the stage tries first.
 * `DISTRACTOR` is the exercise's first false closure, kept as a node no entity ties to the
 * Stripe claim: it is what the KNN widener reaches when the subject leg leaves a slot.
 */
const PAIRS = [
  {
    key: 'queue',
    subject: 'queue writes',
    priorNamesSubject: true,
    prior: 'Queue writes stay inside the main Postgres transaction.',
    next: 'Queue writes move to a separate SQLite database, out of the Postgres transaction.',
  },
  {
    key: 'deploy',
    subject: 'billing service',
    priorNamesSubject: true,
    prior: 'The billing service deploys to AWS us-east-1.',
    next: 'The billing service deploys to Fly.io now; AWS us-east-1 is no longer used.',
  },
  {
    key: 'auth',
    subject: 'session tokens',
    priorNamesSubject: true,
    prior: 'Session tokens are stored in browser local storage.',
    next: 'Session tokens are never stored in local storage; they live in an httpOnly cookie.',
  },
  {
    key: 'stripe',
    subject: 'stripe webhook',
    priorNamesSubject: true,
    prior: 'The Stripe webhook retry limit is three attempts.',
    next: 'Raise the Stripe webhook retry limit from three to seven attempts.',
  },
  {
    key: 'bait-temporal',
    subject: 'reconciliation job',
    priorNamesSubject: true,
    prior: 'The reconciliation job ran for four hours during the July close.',
    next: 'The reconciliation job now takes forty minutes, after the covering index landed.',
  },
] as const;

/** A different service's retry policy: shared vocabulary, separate subject, still true. */
const DISTRACTOR =
  'The payments worker retry backoff is capped at four attempts to prevent duplicate captures.';

type SeededPair = {
  readonly priorId: string;
  readonly nextId: string;
  readonly nextEpisodeId: string;
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let ollama: OllamaProvider;
let distractorId: string;
const pairs = new Map<string, SeededPair>();

function ollamaProvider(): OllamaProvider {
  return new OllamaProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });
}

/** Answers every judgment the same way, so the mode split is the only variable. */
function stubProvider(confidence: number, calls: StructuredRequest[]): Provider {
  return {
    embed: async () => [],
    generate: async (req: StructuredRequest) => {
      calls.push(req);
      return { contradicts: true, confidence, rationale: 'the later statement reverses the earlier one' };
    },
  };
}

function liveProvider(calls: StructuredRequest[]): Provider {
  return {
    embed: async (texts) => ollama.embed(texts),
    generate: async (req: StructuredRequest) => {
      calls.push(req);
      return ollama.generate(req);
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
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };

  for (const pair of PAIRS) {
    const priorEpisode = await handleReflection(
      intake,
      { turns: [{ role: 'assistant', text: pair.prior }], summary: `${pair.key} baseline` },
      { identity: `mcp-supersession-${pair.key}-prior` },
    );
    const nextEpisode = await handleReflection(
      intake,
      { turns: [{ role: 'assistant', text: pair.next }], summary: `${pair.key} revised` },
      { identity: `mcp-supersession-${pair.key}-next` },
    );

    const now = new Date();
    const [entity] = await mergeEntities(
      harness.driver,
      [
        {
          name: pair.subject,
          nameNorm: pair.subject.toLowerCase(),
          type: 'concept',
          text: `${pair.subject} (concept)`,
          sourceEpisodeId: nextEpisode.episode_id,
          extractionMethod: 'test-seed',
          confidence: 1,
        },
      ],
      now,
    );
    const mentionedBy = pair.priorNamesSubject
      ? [priorEpisode.episode_id, nextEpisode.episode_id]
      : [nextEpisode.episode_id];
    for (const episodeId of mentionedBy) {
      await linkEntityMentions(harness.driver, {
        episodeId,
        entityIds: [entity!.id],
        now,
        confidence: 1,
        provenance: ['test-seed'],
      });
    }

    const [priorVector, nextVector] = await ollama.embed([pair.prior, pair.next]);
    const prior = await writeCognitiveNode(harness.driver, {
      episodeId: priorEpisode.episode_id,
      label: 'Concept',
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

  const distractorEpisode = await handleReflection(
    intake,
    { turns: [{ role: 'assistant', text: DISTRACTOR }], summary: 'payments worker backoff' },
    { identity: 'mcp-supersession-distractor' },
  );
  const [distractorVector] = await ollama.embed([DISTRACTOR]);
  const distractor = await writeCognitiveNode(harness.driver, {
    episodeId: distractorEpisode.episode_id,
    label: 'Decision',
    text: DISTRACTOR,
    contentVector: distractorVector,
    now: new Date(),
  });
  distractorId = distractor.node.id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SupersessionStage against a live graph', () => {
  it('reaches the same-subject claim across labels, and proposes rather than closing it', async () => {
    const pair = pairs.get('queue')!;
    const calls: StructuredRequest[] = [];

    const ctx = await contextFor(pair.nextEpisodeId, liveProvider(calls));
    const outcome = await new SupersessionStage({
      model: DEFAULTS.models.reflect,
      maxNeighbors: 1,
    }).run(ctx);

    expect(outcome.status).toBe('ok');
    // The subject leg is what this asserts: a Concept baseline and a Decision correction are
    // paired because both name the entity, which the same-label KNN scan could not do.
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain(PAIRS[0].prior);
    expect(prompt).toContain(PAIRS[0].next);
    expect(prompt).toContain('Both statements name: queue writes');

    expect(outcome.counts?.supersessions).toBe(0);
    expect(outcome.counts?.supersessionProposals).toBe(1);
    const proposal = listSupersessionProposals(db).find((row) => row.oldId === pair.priorId);
    expect(proposal).toMatchObject({ newId: pair.nextId, episodeId: pair.nextEpisodeId });

    const hits = await vectorSeeds(harness.driver, {
      vector: (await contentVectors(harness.driver, { ids: [pair.nextId], mode: withCurrency() }))[0]!
        .vector,
      limit: 25,
      mode: withCurrency(),
    });
    expect(hits.find((hit) => hit.id === pair.priorId)?.currency).toBe('current');
  }, 180_000);

  it('spends its judgment on the same subject, not on the closer different-subject claim', async () => {
    const pair = pairs.get('stripe')!;
    const calls: StructuredRequest[] = [];

    const ctx = await contextFor(pair.nextEpisodeId, liveProvider(calls));
    const outcome = await new SupersessionStage({
      model: DEFAULTS.models.reflect,
      maxNeighbors: 1,
    }).run(ctx);

    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('The Stripe webhook retry limit is three attempts.');
    expect(prompt).not.toContain('duplicate captures');
    expect(outcome.counts?.supersessions).toBe(0);
  }, 180_000);

  /**
   * The judge still answers "contradicts" on this pair, measured against qwen3:8b with the
   * discipline rules in the prompt. That is the finding the propose-only default exists for:
   * a false positive costs a review row, and the node it names stays current and served.
   */
  it('contains a false positive as a proposal when the widener does reach one', async () => {
    const pair = pairs.get('stripe')!;
    const calls: StructuredRequest[] = [];

    const ctx = await contextFor(pair.nextEpisodeId, liveProvider(calls));
    const outcome = await new SupersessionStage({
      model: DEFAULTS.models.reflect,
      maxNeighbors: 2,
      neighborThreshold: 0.4,
    }).run(ctx);

    const prompts = calls.map((call) => call.messages.map((message) => message.content).join('\n'));
    expect(prompts.some((prompt) => prompt.includes('duplicate captures'))).toBe(true);
    expect(outcome.counts?.supersessions).toBe(0);

    const hits = await vectorSeeds(harness.driver, {
      vector: (await contentVectors(harness.driver, { ids: [distractorId], mode: withCurrency() }))[0]!
        .vector,
      limit: 25,
      mode: withCurrency(),
    });
    expect(hits.find((hit) => hit.id === distractorId)?.currency).toBe('current');
  }, 180_000);

  it('leaves the temporal bait alone after judging it', async () => {
    const pair = pairs.get('bait-temporal')!;
    const calls: StructuredRequest[] = [];

    const ctx = await contextFor(pair.nextEpisodeId, liveProvider(calls));
    const outcome = await new SupersessionStage({
      model: DEFAULTS.models.reflect,
      maxNeighbors: 1,
    }).run(ctx);

    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('The reconciliation job ran for four hours during the July close.');
    expect(prompt).toContain('Both statements name: reconciliation job');
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 0 });
    expect(listSupersessionProposals(db).some((row) => row.oldId === pair.priorId)).toBe(false);
  }, 180_000);

  it('records a proposal and leaves the graph untouched whatever the confidence', async () => {
    const pair = pairs.get('auth')!;
    const calls: StructuredRequest[] = [];

    const ctx = await contextFor(pair.nextEpisodeId, stubProvider(1, calls));
    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(ctx);

    expect(calls).toHaveLength(1);
    expect(outcome.counts?.supersessions).toBe(0);
    expect(outcome.counts?.supersessionProposals).toBe(1);

    const proposal = listSupersessionProposals(db).find((row) => row.oldId === pair.priorId);
    expect(proposal).toMatchObject({
      newId: pair.nextId,
      confidence: 1,
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

  it('closes the old node with lineage in auto mode', async () => {
    const pair = pairs.get('deploy')!;
    const calls: StructuredRequest[] = [];

    const ctx = await contextFor(pair.nextEpisodeId, stubProvider(0.95, calls));
    const outcome = await new SupersessionStage({ mode: 'auto', maxNeighbors: 1 }).run(ctx);

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
});
