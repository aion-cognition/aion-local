import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { findEpisodeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { entitySimilaritySeeds } from '../../../infrastructure/graph/seed-queries.js';
import {
  mentionCounts,
  participationCount,
  storedEntities,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { SessionManager } from '../../../session/session-manager.js';
import { ENTITY_TYPES } from '../../domain/entity-extraction.js';
import type { StageContext, StageOutcome } from '../../domain/stage.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';
import { EntityExtractionStage } from './entities.js';

const MEMBER_NAME = 'Ryan Huber';
const NOW = new Date('2026-08-28T12:00:00.000Z');

/** A real working session: named people, a project, a tool, and a decision to reason over. */
const LIVE_PAYLOAD = {
  summary: 'planning the Aion reflection pipeline with Priya Raman',
  turns: [
    {
      role: 'user',
      text: 'Priya Raman and I reviewed the Aion reflection pipeline this morning. We are keeping Neo4j as the graph store.',
      occurred_at: '2026-08-28T09:00:00Z',
    },
    {
      role: 'assistant',
      text: 'Understood. Aion will extract entities with Ollama running locally, and Priya Raman owns the Neo4j migration.',
      occurred_at: '2026-08-28T09:00:30Z',
    },
  ],
  observations: ['The team meets again in Berlin next quarter'],
};

/** A second episode, extracted by a stub so the graph writes are measured without the model. */
const STUB_PAYLOAD = {
  summary: 'the canonicalization pass',
  turns: [
    {
      role: 'user',
      text: 'Ryan Huber merged the Aion entity stage',
      occurred_at: '2026-08-28T11:00:00Z',
    },
  ],
};

const STUB_EXTRACTION = {
  entities: [
    {
      name: 'ryan   HUBER',
      type: 'person',
      context: 'the member the backbone already answers to',
      is_speaker: true,
    },
    { name: 'Aion', type: 'project', context: 'the memory substrate', aliases: ['aion-local'] },
    { name: 'Aion', type: 'tool', context: 'the same name under a second reading' },
    { name: 'Aion', type: 'project', context: 'a duplicate the model returned twice' },
    {
      name: 'proposal-hygiene',
      type: 'tool',
      context: 'the maintenance operation',
      aliases: ['proposal_hygiene'],
    },
  ],
};

/** A later record spelling the same identities differently, each by a name they already answer to. */
const RESPELLED_EXTRACTION = {
  entities: [
    { name: 'Ry', type: 'person', context: 'the speaker under a short name', is_speaker: true },
    { name: 'aion-local', type: 'topic', context: 'the substrate under one of its aliases' },
    // Squash equality routes nothing at write, so this spelling reaches its identity only
    // because the record that named it first gave it as an alias.
    { name: 'proposal_hygiene', type: 'topic', context: 'the same operation, other separator' },
  ],
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let liveEpisodeId: string;
let stubEpisodeId: string;
let memberId: string;
let provider: Provider;

function stubProvider(): Provider {
  return {
    embed: async (texts: readonly string[]): Promise<Vector[]> => provider.embed(texts),
    generate: async (): Promise<unknown> => STUB_EXTRACTION,
  };
}

async function runStage(episodeId: string, stageProvider: Provider): Promise<StageOutcome> {
  const episode = await loadEpisodeContext(harness.driver, episodeId);
  if (episode === undefined) {
    throw new Error(`no episode ${episodeId}`);
  }
  const context: StageContext = {
    driver: harness.driver,
    db,
    provider: stageProvider,
    episodeId,
    episode,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
  };
  return new EntityExtractionStage().run(context);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entities-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });

  provider = testGenerationProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  memberId = backbone.member.id;

  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };

  liveEpisodeId = (await handleReflection(intake, LIVE_PAYLOAD, { identity: 'entities-live' }))
    .episode_id;
  stubEpisodeId = (await handleReflection(intake, STUB_PAYLOAD, { identity: 'entities-stub' }))
    .episode_id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('canonicalization against the live constraint', () => {
  it('collapses the extraction onto one node per identity and upgrades the backbone name in place', async () => {
    const outcome = await runStage(stubEpisodeId, stubProvider());

    expect(outcome.status).toBe('ok');
    // Five rows in, three identities out: the repeat collapses, and so does the second reading.
    expect(outcome.counts).toEqual({ entities: 2, mentions: 3 });

    const entities = await storedEntities(harness.driver);
    const member = entities.find((entity) => entity.id === memberId);
    expect(member?.structural).toBe(true);
    expect(member?.type).toBe('member');
    // The backbone gains a name embedding and nothing else: it is connectivity, not content.
    expect(member?.nameVectorLength).toBe(DEFAULTS.models.embedDimension);
    expect(member?.contentVectorLength).toBe(0);
    expect(member?.text).toBeNull();
    expect(member?.labels).not.toContain('Memory');

    expect(entities.filter((entity) => entity.nameNorm === 'ryan huber')).toHaveLength(1);

    const aion = entities.filter((entity) => entity.nameNorm === 'aion');
    expect(aion).toHaveLength(1);
    // Two readings, one identity: both are counted and the first one stands as the label.
    expect(aion[0]?.type).toBe('project');
    expect(aion[0]?.typeCounts).toBe('{"project":1,"tool":1}');
    expect(aion[0]?.aliasesNorm).toEqual(['aion-local']);
    expect(aion[0]?.nameSquash).toBe('aion');
  });

  it('gives every extracted entity the Memory label, its text, and both vectors', async () => {
    const extracted = (await storedEntities(harness.driver)).filter((entity) => !entity.structural);

    expect(extracted.length).toBeGreaterThan(0);
    for (const entity of extracted) {
      expect(entity.labels).toEqual(expect.arrayContaining(['Entity', 'Memory', 'AionNode']));
      expect(entity.text).toContain(entity.name);
      expect(entity.nameVectorLength).toBe(DEFAULTS.models.embedDimension);
      expect(entity.contentVectorLength).toBe(DEFAULTS.models.embedDimension);
    }
  });

  it('links the episode to every entity it mentioned, both ways', async () => {
    const mentions = await mentionCounts(harness.driver, stubEpisodeId);
    const entities = await findEpisodeEntities(harness.driver, stubEpisodeId);

    expect(mentions).toHaveLength(3);
    expect(entities.map((entity) => entity.nameNorm)).toEqual([
      'aion',
      'proposal-hygiene',
      'ryan huber',
    ]);
    expect(await participationCount(harness.driver, stubEpisodeId)).toBe(3);
  });

  it('converges on a re-run: no new node, no second edge, one summed mention count', async () => {
    const before = await storedEntities(harness.driver);
    const outcome = await runStage(stubEpisodeId, stubProvider());

    expect(outcome.counts).toEqual({ entities: 0, mentions: 3 });

    const after = await storedEntities(harness.driver);
    expect(after.map((entity) => entity.id)).toEqual(before.map((entity) => entity.id));

    const mentions = await mentionCounts(harness.driver, stubEpisodeId);
    expect(mentions.map((mention) => mention.count)).toEqual([2, 2, 2]);
    expect(new Set(mentions.map((mention) => mention.id))).toEqual(
      new Set(before.filter((entity) => entity.accessCount > 0).map((entity) => entity.id)),
    );
    // Salience is a counter by design, so a second mention counts twice.
    expect(after.filter((entity) => entity.accessCount === 2)).toHaveLength(3);
  });

  it('routes a respelling onto the identity that already answers to it, minting nothing', async () => {
    const before = await storedEntities(harness.driver);
    const outcome = await runStage(stubEpisodeId, {
      embed: async (texts: readonly string[]): Promise<Vector[]> => provider.embed(texts),
      generate: async (): Promise<unknown> => RESPELLED_EXTRACTION,
    });

    expect(outcome.counts).toEqual({ entities: 0, mentions: 3 });

    const after = await storedEntities(harness.driver);
    expect(after.map((entity) => entity.id).sort()).toEqual(
      before.map((entity) => entity.id).sort(),
    );

    // The speaker is the backbone under whatever the record called them.
    const member = after.find((entity) => entity.id === memberId);
    expect(member?.aliasesNorm).toContain('ry');
    expect(member?.type).toBe('member');

    // The alias tier, on a nickname and on a separator variant the first record declared.
    const aion = after.find((entity) => entity.nameNorm === 'aion');
    expect(aion?.aliasesNorm).toContain('aion-local');
    const hygiene = after.find((entity) => entity.nameNorm === 'proposal-hygiene');
    expect(hygiene?.aliasesNorm).toContain('proposal_hygiene');
  });
});

describe('entity extraction against a live model', () => {
  it('turns a real episode into typed, vectorized, mentioned entities', async () => {
    const outcome = await runStage(liveEpisodeId, provider);

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.entities ?? 0).toBeGreaterThan(0);

    const entities = await findEpisodeEntities(harness.driver, liveEpisodeId);
    expect(entities.length).toBeGreaterThan(1);
    // The backbone is exempt: the speaker routes onto the Member, which keeps `member` as its
    // type because a mention never relabels the node every session hangs off.
    for (const entity of entities.filter((row) => row.id !== memberId)) {
      expect(ENTITY_TYPES as readonly string[]).toContain(entity.type);
    }

    const stored = await storedEntities(harness.driver);
    const mentioned = new Set(entities.map((entity) => entity.id));
    for (const entity of stored.filter((row) => mentioned.has(row.id) && !row.structural)) {
      expect(entity.nameVectorLength).toBe(DEFAULTS.models.embedDimension);
      expect(entity.contentVectorLength).toBe(DEFAULTS.models.embedDimension);
    }
    expect(await participationCount(harness.driver, liveEpisodeId)).toBe(entities.length);
  }, 180_000);

  it('writes the name embedding the entity-resolution seed strategy searches', async () => {
    const entities = await findEpisodeEntities(harness.driver, liveEpisodeId);
    const target = entities.find((entity) => entity.id !== memberId);
    const [vector] = await provider.embed([target?.name ?? '']);

    const rows = await entitySimilaritySeeds(harness.driver, {
      vector: vector ?? [],
      threshold: DEFAULTS.recall.entityMatchThreshold,
      limit: 10,
      mode: withCurrency(),
    });

    expect(rows.map((row) => row.id)).toContain(target?.id);
  }, 120_000);

  it('adds no duplicate identity when the same episode is extracted twice', async () => {
    const before = await storedEntities(harness.driver);
    const outcome = await runStage(liveEpisodeId, provider);
    const after = await storedEntities(harness.driver);

    // Whatever the model names the second time, every node it lands on is one the graph
    // already had or one this run reports creating.
    expect(after).toHaveLength(before.length + (outcome.counts?.entities ?? 0));
    const identities = after.map((entity) => entity.nameNorm);
    expect(new Set(identities).size).toBe(identities.length);

    const mentions = await mentionCounts(harness.driver, liveEpisodeId);
    expect(new Set(mentions.map((mention) => mention.id)).size).toBe(mentions.length);
  }, 180_000);
});
