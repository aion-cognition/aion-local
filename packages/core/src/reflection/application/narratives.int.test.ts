import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import {
  closeSessionNarrative,
  DEFAULT_SESSION_IDLE_MS,
  sweepIdleSessions,
  type NarrativeDeps,
} from './narratives.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../infrastructure/graph/cognitive-queries.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  DERIVES_FROM_TYPE,
  findIdleSessions,
  findSessionNarratives,
  loadSessionEpisodes,
  loadSessionSourceNodes,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import {
  escapeLuceneQuery,
  fulltextSeeds,
  vectorSeeds,
} from '../../infrastructure/graph/seed-queries.js';
import {
  countEdges,
  countOutgoingEdges,
  edgeTargetId,
  episodeIdsInSession,
  nodeLabels,
  nodeProperties,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { SessionManager } from '../../session/session-manager.js';

// The structural describes (versioning, provenance edges, idle-sweep bookkeeping) prove
// Cypher and orchestration, not prose quality, and the suite must never depend on model
// output quality. A live pass occasionally grounds zero sentences, which reads as
// status 'failed' and would hold those structural assertions hostage, so they run on a
// deterministic provider that always cites the first source node the prompt offers. The
// grounding describe below keeps the live model: grounding quality is its actual subject.
function deterministicNarrativeProvider(): NarrativeDeps['provider'] {
  const live = provider();
  return {
    embed: (texts) => live.embed(texts),
    generate: (request) => {
      const prompt = request.messages.map((message) => message.content).join('\n');
      const handles = [...new Set(prompt.match(/\[S\d+\]/g) ?? [])].map((tag) => tag.slice(1, -1));
      const cited = handles.slice(0, 2);
      return Promise.resolve({
        sentences: [
          {
            text: 'The session staged, migrated, and held the Ariadne rollout.',
            source_ids: cited,
          },
        ],
      });
    },
  };
}

// The grounding describe asserts live-model behavior on purpose, and a saturated host can
// fail one pass without saying anything about grounding. One retry absorbs contention; a
// double failure is a real grounding result and should fail the test.
async function closeWithGroundingRetry(
  narrativeDeps: NarrativeDeps,
  identity: string,
): ReturnType<typeof closeSessionNarrative> {
  const first = await closeSessionNarrative(narrativeDeps, identity);
  if (first.status !== 'failed') {
    return first;
  }
  return closeSessionNarrative(narrativeDeps, identity);
}

/**
 * The whole boundary against a live substrate: episodes pushed through a session, the close
 * compressing them with the reflect model, and the narrative that results reachable by both
 * retrieval legs. What only a real server proves here is the Cypher: the idle-session
 * aggregation, the version read, and `content_fts` actually covering `Narrative`.
 */

const SESSION_IDENTITY = 'mcp-transport-session-narratives';
const IDLE_SESSION_IDENTITY = 'mcp-transport-session-narratives-idle';
const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const EPISODES = [
  {
    summary: 'planning the Ariadne rollout',
    turns: [
      {
        role: 'user',
        text: 'we need the Ariadne rollout staged behind a flag',
        occurred_at: '2026-04-02T09:00:00Z',
      },
      {
        role: 'assistant',
        text: 'staging it behind AION_ARIADNE and defaulting it off',
        occurred_at: '2026-04-02T09:00:30Z',
      },
    ],
  },
  {
    summary: 'the Ariadne migration ran',
    turns: [
      {
        role: 'user',
        text: 'run the Ariadne migration against the staging substrate',
        occurred_at: '2026-04-02T09:20:00Z',
      },
      {
        role: 'assistant',
        text: 'migration applied, every constraint came back green',
        occurred_at: '2026-04-02T09:21:00Z',
      },
    ],
    observations: ['The migration is idempotent: the second run created nothing'],
  },
  {
    summary: 'we decided to hold the Ariadne launch',
    turns: [
      {
        role: 'user',
        text: 'hold the launch until the backfill finishes',
        occurred_at: '2026-04-02T09:40:00Z',
      },
      {
        role: 'assistant',
        text: 'holding it; the backfill has about a day left',
        occurred_at: '2026-04-02T09:41:00Z',
      },
    ],
  },
];

/** A thin fixture: 27 words that produced eight invented sentences when compressed. */
const THIN_SESSION_IDENTITY = 'mcp-transport-session-narratives-thin';
const THIN_EPISODE = {
  summary: 'close-mode probe terminate',
  observations: [
    'Close-hook probe using terminate. One observation so the session has an episode to narrate.',
  ],
};

/** The realistic planning session: decisions the narrative has to name rather than invent. */
const PLANNING_SESSION_IDENTITY = 'mcp-transport-session-narratives-planning';
const PLANNING_EPISODE = {
  summary:
    'planning the Meridian rollout: four decisions taken and two alternative approaches rejected',
  turns: [
    {
      role: 'user',
      text: 'walk through the rollout decisions we settled on for Meridian this afternoon',
      occurred_at: '2026-04-03T09:00:00Z',
    },
    {
      role: 'assistant',
      text: 'four decisions: the orders table stays unsharded, session state moves to signed cookies, Meridian ships behind a flag with two weeks of shadow reads, and this service never writes to the finops-owned billing table',
      occurred_at: '2026-04-03T09:01:00Z',
    },
  ],
};

const PLANNING_DECISIONS = [
  'Do not shard the orders table; the write volume does not justify the operational cost yet',
  'Move session state to signed cookies instead of keeping it in the Redis store',
  'Ship Meridian behind a flag with two weeks of shadow reads before any cutover',
  'Do not write to the finops-owned billing table from this service under any circumstance',
];

const PLANNING_INSIGHT =
  'Shadow reads are the only way to compare Meridian against the current path without user-visible risk';

const LATE_EPISODE = {
  summary: 'the backfill finished and Ariadne launched',
  turns: [
    { role: 'user', text: 'backfill is done, launch Ariadne', occurred_at: '2026-04-02T18:00:00Z' },
    {
      role: 'assistant',
      text: 'flag flipped on, launch is live',
      occurred_at: '2026-04-02T18:01:00Z',
    },
  ],
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let intake: ReflectionIntakeDeps;
let deps: NarrativeDeps;
let structuralDeps: NarrativeDeps;
let firstNarrativeId: string;

function provider(): Provider {
  return testGenerationProvider({ baseUrl: OLLAMA_URL, embedModel: DEFAULTS.models.embed });
}

async function push(payload: unknown, identity: string): Promise<string> {
  const stored = await handleReflection(intake, payload, { identity });
  return stored.episode_id;
}

/** The sweep measures idleness against its own clock, so a session written seconds ago looks quiet from here. */
function afterTheIdleWindow(): Date {
  return new Date(Date.now() + DEFAULT_SESSION_IDLE_MS + 60_000);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-narratives-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  const logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });

  intake = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: provider(),
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };
  deps = { driver: harness.driver, provider: provider(), logger };
  structuralDeps = { driver: harness.driver, provider: deterministicNarrativeProvider(), logger };

  for (const payload of EPISODES) {
    await push(payload, SESSION_IDENTITY);
  }
  await push(EPISODES[0], IDLE_SESSION_IDENTITY);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('session close against a live substrate', () => {
  it('reads the session back in the order it happened', async () => {
    const episodes = await loadSessionEpisodes(harness.driver, SESSION_IDENTITY);

    expect(episodes).toHaveLength(3);
    expect(episodes.map((episode) => episode.summary)).toEqual(EPISODES.map((e) => e.summary));
    expect(episodes[0]?.writtenAt).toBeInstanceOf(Date);
  });

  it('compresses the session into a narrative with provenance and a vector', async () => {
    const result = await closeSessionNarrative(structuralDeps, SESSION_IDENTITY);

    expect(result.status).toBe('created');
    expect(result.version).toBe(1);
    expect(result.episodes).toBe(3);
    firstNarrativeId = result.narrativeId!;

    expect(await nodeLabels(harness.driver, firstNarrativeId)).toEqual([
      'AionNode',
      'Memory',
      'Narrative',
    ]);

    const properties = await nodeProperties(harness.driver, firstNarrativeId);
    expect(properties[NARRATIVE_PROPERTIES.scope]).toBe('session');
    expect(properties[NARRATIVE_PROPERTIES.version]).toBe(1);
    expect(properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(3);
    expect(properties[NARRATIVE_PROPERTIES.coverage]).toBe(1);
    expect(
      ((properties[MEMORY_PROPERTIES.summary] as string | undefined) ?? '').length,
    ).toBeGreaterThan(0);
    expect(
      ((properties[MEMORY_PROPERTIES.text] as string | undefined) ?? '').length,
    ).toBeGreaterThan(0);
    expect(properties[MEMORY_PROPERTIES.contentVector]).toHaveLength(
      DEFAULTS.models.embedDimension,
    );

    const episodeIds = await episodeIdsInSession(harness.driver, SESSION_IDENTITY);
    expect(episodeIds).toHaveLength(3);
    for (const episodeId of episodeIds) {
      expect(
        await countEdges(harness.driver, SUMMARIZED_BY_TYPE, episodeId, firstNarrativeId),
      ).toBe(1);
    }
    expect(await countOutgoingEdges(harness.driver, DERIVES_FROM_TYPE, firstNarrativeId)).toBe(1);
    expect(await edgeTargetId(harness.driver, DERIVES_FROM_TYPE, firstNarrativeId)).toBe(
      SESSION_IDENTITY,
    );
  }, 120_000);

  it('is found by a broad recall, by vector and by fulltext', async () => {
    const [query] = await deps.provider.embed(['what has this session been working on']);
    const byVector = await vectorSeeds(harness.driver, {
      vector: query ?? [],
      limit: 10,
      mode: withCurrency(),
    });
    // Whether model-written prose ranks in the top 10 for a generic query is a quality
    // measurement, not a contract: advisory only, the quality harness owns it.
    if (!byVector.some((seed) => seed.id === firstNarrativeId)) {
      console.warn('advisory: narrative missed vector top-10 for the generic session query');
    }

    // The query is the narrative's own summary line, escaped, because the wording the model
    // chose is not predictable: what this proves is that `content_fts` covers `Narrative` at
    // all, which is the half a migration can get wrong.
    const summary =
      byVector.find((seed) => seed.id === firstNarrativeId)?.content ??
      ((await nodeProperties(harness.driver, firstNarrativeId))[MEMORY_PROPERTIES.summary] as
        string | undefined) ??
      '';
    const byText = await fulltextSeeds(harness.driver, {
      query: escapeLuceneQuery(summary),
      limit: 10,
      mode: withCurrency(),
    });
    expect(byText.map((seed) => seed.id)).toContain(firstNarrativeId);
  }, 120_000);

  it('writes nothing on a re-close over the same episodes', async () => {
    const result = await closeSessionNarrative(structuralDeps, SESSION_IDENTITY);

    expect(result.status).toBe('skipped');
    expect(await findSessionNarratives(harness.driver, SESSION_IDENTITY)).toHaveLength(1);
  });

  it('mints version 2 and supersedes version 1 once the session grew', async () => {
    await push(LATE_EPISODE, SESSION_IDENTITY);

    const result = await closeSessionNarrative(structuralDeps, SESSION_IDENTITY);

    expect(result.status).toBe('created');
    expect(result.version).toBe(2);

    const versions = await findSessionNarratives(harness.driver, SESSION_IDENTITY);
    expect(
      versions.map((version) => [version.version, version.open, version.coverageCount]),
    ).toEqual([
      [2, true, 4],
      [1, false, 3],
    ]);

    expect(await edgeTargetId(harness.driver, 'SUPERSEDES', result.narrativeId!)).toBe(
      firstNarrativeId,
    );
    const closed = await nodeProperties(harness.driver, firstNarrativeId);
    expect(closed[BITEMPORAL_PROPERTIES.validUntil]).toBeInstanceOf(Date);
    expect(closed[BITEMPORAL_PROPERTIES.txUntil]).toBeInstanceOf(Date);
  }, 120_000);
});

describe('idle sweep against a live substrate', () => {
  it('offers only the session that has gone quiet and is not yet covered', async () => {
    const idle = await findIdleSessions(harness.driver, {
      idleBefore: new Date(Date.now() + 60_000),
      limit: 10,
    });

    expect(idle.map((session) => session.sessionId)).toEqual([IDLE_SESSION_IDENTITY]);
    expect(idle[0]?.episodeCount).toBe(1);
    expect(idle[0]?.lastActivityAt).toBeInstanceOf(Date);
  });

  it('narrates it, and then stops offering it', async () => {
    const results = await sweepIdleSessions(structuralDeps, { now: afterTheIdleWindow() });

    expect(results.map((result) => [result.sessionId, result.status])).toEqual([
      [IDLE_SESSION_IDENTITY, 'created'],
    ]);

    const covered = await findSessionNarratives(harness.driver, IDLE_SESSION_IDENTITY);
    expect(covered).toHaveLength(1);
    expect(covered[0]?.open).toBe(true);

    const again = await sweepIdleSessions(structuralDeps, { now: afterTheIdleWindow() });
    expect(again).toEqual([]);
  }, 120_000);
});

/**
 * Grounding, against the model that fabricated. The assertions are structural: how many
 * sentences survived and which node ids they cited, because a string match against the
 * source would only prove the model echoed wording, not that the claim is sourced.
 */
describe('grounding against a live substrate', () => {
  let thinEpisodeId: string;
  let planningEpisodeId: string;
  const decisionIds: string[] = [];

  beforeAll(async () => {
    thinEpisodeId = await push(THIN_EPISODE, THIN_SESSION_IDENTITY);
    planningEpisodeId = await push(PLANNING_EPISODE, PLANNING_SESSION_IDENTITY);

    const now = new Date();
    for (const text of PLANNING_DECISIONS) {
      const written = await writeCognitiveNode(harness.driver, {
        episodeId: planningEpisodeId,
        label: 'Decision',
        text,
        now,
      });
      decisionIds.push(written.node.id);
    }
    await writeCognitiveNode(harness.driver, {
      episodeId: planningEpisodeId,
      label: 'Insight',
      text: PLANNING_INSIGHT,
      now,
    });
  }, 120_000);

  it('turns 27 words of source into one grounded sentence, not eight invented ones', async () => {
    const result = await closeWithGroundingRetry(deps, THIN_SESSION_IDENTITY);

    expect(result.status).toBe('created');
    const properties = await nodeProperties(harness.driver, result.narrativeId!);
    const citations = properties[NARRATIVE_PROPERTIES.citations] as string[];

    expect(properties[NARRATIVE_PROPERTIES.sentenceCount]).toBe(1);
    expect(citations.length).toBeGreaterThan(0);
    // Every citation resolves to a node the session actually holds: nothing else could be cited.
    expect(citations.every((id) => id === thinEpisodeId)).toBe(true);
  }, 180_000);

  it('names the decisions the planning session actually took', async () => {
    const sources = await loadSessionSourceNodes(harness.driver, PLANNING_SESSION_IDENTITY);
    expect(sources.map((source) => source.id).sort()).toEqual(
      [...decisionIds].concat(sources.filter((s) => s.kind === 'insight').map((s) => s.id)).sort(),
    );

    const result = await closeWithGroundingRetry(deps, PLANNING_SESSION_IDENTITY);

    expect(result.status).toBe('created');
    const properties = await nodeProperties(harness.driver, result.narrativeId!);
    const citations = properties[NARRATIVE_PROPERTIES.citations] as string[];
    const sourceIds = new Set([planningEpisodeId, ...sources.map((source) => source.id)]);

    expect(citations.every((id) => sourceIds.has(id))).toBe(true);
    expect(citations.filter((id) => decisionIds.includes(id)).length).toBeGreaterThan(0);
    expect(Number(properties[NARRATIVE_PROPERTIES.sentenceCount])).toBeGreaterThan(1);
  }, 180_000);
});
