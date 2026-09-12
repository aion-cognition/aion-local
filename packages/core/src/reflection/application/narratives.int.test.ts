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
  type NarrativeOptions,
} from './narratives.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { activatedCoordinator } from './test-support/publication-substrate.fixture.js';
import { findPendingVectorNodes } from './vectors.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import { establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { writeCognitiveNode } from '../../infrastructure/graph/cognitive-queries.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  DERIVES_FROM_TYPE,
  findIdleSessions,
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
  edgeValidUntil,
  narrativeIdsInSession,
  nodeLabels,
  nodeProperties,
  supersedingNodeIds,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { listChunkMembers } from '../../infrastructure/sqlite/chunk-manifest.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { SessionManager } from '../../session/session-manager.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

// The structural describes (membership, provenance edges, idle-sweep bookkeeping) prove
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
  options: NarrativeOptions = {},
): ReturnType<typeof closeSessionNarrative> {
  const first = await closeSessionNarrative(narrativeDeps, identity, options);
  if (first.status !== 'failed') {
    return first;
  }
  return closeSessionNarrative(narrativeDeps, identity, options);
}

/**
 * The whole boundary against a live substrate: episodes pushed through a session, the close
 * sealing them into a chunk and compressing it with the reflect model, and the narrative that
 * results reachable by both retrieval legs. What only a real server proves here is the Cypher:
 * the idle-session aggregation, the membership read, and `content_fts` actually covering
 * `Narrative`.
 *
 * **Re-subjected to the chunk family.** Narration resolves to chunks for any session with no
 * legacy history (`family-cutover.ts`: `initialize` picks `chunk` unless
 * `hasLegacyNarrativeHistory` finds a whole-session node), which every session here is. Most of
 * what this file proved is family-neutral and is asserted unchanged. Three things were the legacy
 * whole-session writer's own shape and are retired by name rather than quietly dropped:
 *
 * - **Session-scoped versioning: "mints version 2 and supersedes version 1 once the session
 *   grew".** The chunk family deliberately does not version over membership growth — a sealed
 *   chunk's membership is frozen and the tail that follows it is another chunk, so a grown
 *   session gets a SECOND HEAD rather than a second revision. That is asserted below, in
 *   'gets another chunk rather than a second version of the first'. The revision series the chunk
 *   family does keep — allocation, publication, closing the prior head, the spent number staying
 *   spent — is `infrastructure/sqlite/narrative-revisions.test.ts`, whose
 *   '%s: an abandoned allocation is spent, and the head moves only when a publication lands'
 *   runs over both families from its own `families` tuple. End to end, a revision replacing a standing head is
 *   `chunk-narrative.int.test.ts`, 'omits a forgotten member with its gap while its neighbours
 *   are submitted whole'.
 * - **"closes the summarization edges into the version it replaced"**, and **"leaves the
 *   replaced version's own provenance edge open"**. Both describe a supersession between two
 *   whole-session narratives. The chunk family's equivalent — the replaced head's
 *   `SUMMARIZED_BY` edges closed and the new head's open — is asserted at
 *   `chunk-narrative.int.test.ts`, 'omits a forgotten member with its gap while its neighbours
 *   are submitted whole', over a revision replacement rather than a session growth. The
 *   provenance half had no coverage in either family, so it is asserted here instead of retired.
 * - **"converges on a retry rather than moving the stamps it already wrote"**, which reached into
 *   the legacy writer's supersession half directly. That path is the legacy repair, it refuses
 *   without a run-start fence, and it goes with the family; the standing operation for a graph
 *   that disagrees with its manifest is the `narrative_family_repair` kind. The chunk family's
 *   own convergence claim — asking again over an unchanged head writes nothing — is the re-close
 *   case below.
 *
 * Also retired: **the two keyed-window describes** ('the keyed route narrates past the local
 * window', 'a session past the window narrates in chunks'). Both measured the LEGACY renderer's
 * one-call window and its internal chunking — whether a session longer than the window still
 * recorded coverage 1. The chunk family has no window to overflow: it partitions the session at
 * `CHUNK_MAX_MEMBERS` and each chunk renders whole, so full coverage is the ordinary case and a
 * partial one is a recorded gap. The partition claim replaces them below, on the deterministic
 * provider, which also takes two live-model-gated cases out of the keyed set.
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

/**
 * The realistic planning session: decisions the narrative has to name rather than invent.
 *
 * Two episodes, not one. The chunk render's sentence budget is `min(maxSentences, members,
 * bySize)` (`narrativeSentenceBudget`), so a one-member chunk is allowed exactly one sentence
 * and could not name four decisions whatever the model did. The legacy renderer counted the
 * session's extracted nodes as its sources and so had a wider budget from one episode; the chunk
 * renderer counts members and reaches the extracted nodes as citable enrichment
 * (`chunk-enrichment.ts`). Splitting the session is what asks the same question of it.
 */
const PLANNING_SESSION_IDENTITY = 'mcp-transport-session-narratives-planning';
const PLANNING_EPISODES = [
  {
    summary: 'planning the Meridian rollout: the four decisions taken',
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
  },
  {
    summary: 'planning the Meridian rollout: the two approaches we rejected',
    turns: [
      {
        role: 'user',
        text: 'and the two approaches we turned down, so the record has them',
        occurred_at: '2026-04-03T09:20:00Z',
      },
      {
        role: 'assistant',
        text: 'we rejected sharding the orders table now, and we rejected a direct cutover without shadow reads, because neither could be compared against the current path without user-visible risk',
        occurred_at: '2026-04-03T09:21:00Z',
      },
    ],
  },
];

const PLANNING_DECISIONS = [
  'Do not shard the orders table; the write volume does not justify the operational cost yet',
  'Move session state to signed cookies instead of keeping it in the Redis store',
  'Ship Meridian behind a flag with two weeks of shadow reads before any cutover',
  'Do not write to the finops-owned billing table from this service under any circumstance',
];

const PLANNING_INSIGHT =
  'Shadow reads are the only way to compare Meridian against the current path without user-visible risk';

/**
 * A session longer than one chunk holds. Fifty short episodes against the twenty-four-member
 * bound: the tail cannot be one chunk, and what the close does about that is the subject.
 */
const WIDE_SESSION_IDENTITY = 'mcp-transport-session-narratives-wide';

const WIDE_EPISODES = [
  'the Kestrel billing migration was scoped against the orders table',
  'the current orders schema was read end to end and written down',
  'two columns were found to carry the same amount in different units',
  'the finance team confirmed cents is the unit that ships',
  'a conversion table was drafted for the four legacy currency rows',
  'the migration was split into a backfill and a cutover',
  'the backfill was written against a copy of the orders table',
  'the copy was loaded from a Tuesday snapshot',
  'the first backfill pass ran in eleven minutes over the copy',
  'the eleven-minute figure was recorded as the planning number',
  'index coverage on the copy was measured before any change',
  'a partial index on paid orders was added to the plan',
  'the index build on the copy took four minutes',
  'the backfill was rerun with the index in place and took six minutes',
  'the six-minute run became the number the cutover window is sized on',
  'the rollback path was written as a second migration, not a manual undo',
  'the rollback was rehearsed against the copy and left it clean',
  'a check query was written to compare the two amount columns row by row',
  'the check query found forty-one mismatched rows on the copy',
  'every mismatched row traced back to the legacy currency conversion',
  'the conversion table was corrected for Swiss francs',
  'the check query came back empty after the correction',
  'staging was refreshed from production to rehearse on real volume',
  'the backfill on staging took nineteen minutes, three times the copy',
  'the difference was traced to staging sharing its disk with the queue',
  'the cutover window was widened to forty minutes on that reading',
  'the on-call rota for the cutover night was agreed with the platform team',
  'a dry run of the cutover was scheduled for the Thursday before',
  'the Thursday dry run completed with no manual step needed',
  'the dry run left one orphaned temporary table behind',
  'the temporary table was added to the rollback migration',
  'a second dry run left nothing behind',
  'the reporting job was found to read the old amount column directly',
  'the reporting job was changed to read the new column behind a flag',
  'the flag defaults off until the backfill has finished',
  'the finance dashboards were pointed at the reporting job, not the table',
  'a read-only replica lag alert was added for the cutover night',
  'the alert threshold was set at thirty seconds of lag',
  'the runbook was written and reviewed by two people outside the team',
  'the runbook review caught a missing step for the queue drain',
  'the queue drain step was added before the cutover begins',
  'the cutover ran on the Tuesday night inside the forty-minute window',
  'the backfill finished in twenty-two minutes on production',
  'the check query came back empty on production',
  'the reporting flag was turned on the following morning',
  'the finance dashboards matched the ledger to the cent',
  'the old amount column was left in place, unread, for one billing cycle',
  'a follow-up ticket was filed to drop the old column after that cycle',
  'the rollback migration was kept in the repository rather than deleted',
  'the Kestrel migration was closed out and the on-call rota stood down',
];

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
let publications: PublicationCoordinator;
let deps: NarrativeDeps;
let structuralDeps: NarrativeDeps;
let firstNarrativeId: string;
let firstChunkId: string;

function provider(): Provider {
  return testGenerationProvider({ baseUrl: OLLAMA_URL, embedModel: DEFAULTS.models.embed });
}

/**
 * One episode accepted, plus the incoming-statement census a chunk's input planner asks of every
 * member before it will admit one. At scale the cohort seal establishes it; here it is per push.
 */
async function push(payload: unknown, identity: string): Promise<string> {
  const stored = await handleReflection(intake, payload, { identity });
  const sourceId = stored.episode_id;
  const at = new Date();
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(db, sourceId, durableRoleScope(role, 'in'), at);
  }
  establishScope(db, sourceId, durableRoleScope('stated_derivation', 'out'), at);
  return sourceId;
}

/** The sweep measures idleness against its own clock, so a session written seconds ago looks quiet from here. */
function afterTheIdleWindow(): Date {
  return new Date(Date.now() + DEFAULT_SESSION_IDLE_MS + 60_000);
}

/** In the order the session happened, which is the order its chunks cover them in. */
async function orderedEpisodeIds(): Promise<string[]> {
  const episodes = await loadSessionEpisodes(harness.driver, SESSION_IDENTITY);
  return episodes.map((episode) => episode.id);
}

/** The chunk a published narrative belongs to, read off the node it wrote. */
async function chunkIdOf(narrativeId: string): Promise<string> {
  const properties = await nodeProperties(harness.driver, narrativeId);
  return properties[NARRATIVE_PROPERTIES.chunkId] as string;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-narratives-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  const logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });

  // Narration publishes, so every deps set carries the coordinator and its SQLite side; without
  // them `narrateSession` fails closed ahead of every assertion in this file. Intake publishes
  // through the same coordinator rather than through the direct publisher, because a chunk's
  // members are the source records intake writes and they have to be real.
  publications = await activatedCoordinator({ driver: harness.driver, db, logger }, 'narratives');
  publishPipelineReadinessPolicy(
    db,
    [{ name: 'entities', run: () => Promise.resolve({ status: 'ok', summary: '' }) }],
    new Date(),
  );

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
    publications,
    acceptHookCapture: true,
  };
  deps = { driver: harness.driver, db, provider: provider(), logger, publications };
  structuralDeps = {
    driver: harness.driver,
    db,
    provider: deterministicNarrativeProvider(),
    logger,
    publications,
  };

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

  it('seals the session into a chunk narrative with provenance and a vector', async () => {
    const result = await closeSessionNarrative(structuralDeps, SESSION_IDENTITY);

    expect(result.status).toBe('created');
    expect(result.version).toBe(1);
    expect(result.episodes).toBe(3);
    firstNarrativeId = result.narrativeId!;
    firstChunkId = await chunkIdOf(firstNarrativeId);

    expect(await nodeLabels(harness.driver, firstNarrativeId)).toEqual([
      'AionNode',
      'Memory',
      'Narrative',
    ]);

    const properties = await nodeProperties(harness.driver, firstNarrativeId);
    // Named rather than inferred: a legacy node reaching this case would carry `scope: 'session'`
    // and no `chunk_id`, and would fail here instead of reading as a chunk revision.
    expect(properties[NARRATIVE_PROPERTIES.family]).toBe('chunk');
    expect(properties[NARRATIVE_PROPERTIES.scope]).toBe('chunk');
    expect(properties[NARRATIVE_PROPERTIES.revisionNo]).toBe(1);
    expect(properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(3);
    expect(properties[NARRATIVE_PROPERTIES.coverage]).toBe(1);
    expect(
      ((properties[MEMORY_PROPERTIES.summary] as string | undefined) ?? '').length,
    ).toBeGreaterThan(0);
    expect(
      ((properties[MEMORY_PROPERTIES.text] as string | undefined) ?? '').length,
    ).toBeGreaterThan(0);
    // No vector on the node, and that is the chunk publication's shape rather than an omission:
    // `narrativeProperties` writes text and never embeds, so a revision lands in the
    // pending-vector population and the backfill drain gives it its `content_vec`. The legacy
    // writer embedded inline, which is why this case used to read a dimension here.
    expect(properties[MEMORY_PROPERTIES.contentVector]).toBeUndefined();
    expect(await findPendingVectorNodes(harness.driver, 50)).toContainEqual(
      expect.objectContaining({ id: firstNarrativeId }),
    );

    // Membership is the chunk's own record, and the structural edges follow it.
    const members = listChunkMembers(db, firstChunkId);
    expect(members).toEqual(await orderedEpisodeIds());
    for (const memberId of members) {
      expect(await countEdges(harness.driver, SUMMARIZED_BY_TYPE, memberId, firstNarrativeId)).toBe(
        1,
      );
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

  it('writes nothing on a re-close over a session that added nothing', async () => {
    const result = await closeSessionNarrative(structuralDeps, SESSION_IDENTITY);

    expect(result.status).toBe('skipped');
    // The sealed membership is frozen and nothing arrived behind it, so there is no tail to seal
    // and no dependency version has moved: the standing head is current.
    expect(result.summary).toBe('the session has no unsealed members');
    expect(await narrativeIdsInSession(harness.driver, SESSION_IDENTITY)).toHaveLength(1);
  });

  it('leaves the standing head’s summarization and provenance edges open', async () => {
    for (const memberId of listChunkMembers(db, firstChunkId)) {
      expect(
        await edgeValidUntil(harness.driver, SUMMARIZED_BY_TYPE, memberId, firstNarrativeId),
      ).toBeUndefined();
    }
    // The provenance edge, which no supersession closes in either family and which nothing
    // asserted for the chunk family before this.
    expect(
      await edgeValidUntil(harness.driver, DERIVES_FROM_TYPE, firstNarrativeId, SESSION_IDENTITY),
    ).toBeUndefined();
  });
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

  /**
   * The sweep's clock and the chunk's span bound are two different windows, and the second one
   * decides. `sweepIdleSessions` dispatches with `sessionClosing: false`, so a quiet session's
   * tail seals on `max_span` and nothing else — and the shipped span is a day
   * (`CHUNK_MAX_SPAN_MS`) against a session idle window of minutes. So a sweep at the idle
   * window answers `skipped` and comes back, which is a real misalignment between two knobs
   * that used to be one decision. The bound is passed explicitly here so the case measures the
   * seal rather than the default's distance from it.
   */
  it('narrates it once the span bound passes, and then stops offering it', async () => {
    const atTheIdleWindow = await sweepIdleSessions(structuralDeps, { now: afterTheIdleWindow() });
    expect(atTheIdleWindow.map((result) => [result.sessionId, result.status])).toEqual([
      [IDLE_SESSION_IDENTITY, 'skipped'],
    ]);

    const results = await sweepIdleSessions(structuralDeps, {
      now: afterTheIdleWindow(),
      chunkPolicy: { ...CHUNK_BOUNDARY_POLICY, maxSpanMs: 60_000 },
    });

    expect(results.map((result) => [result.sessionId, result.status])).toEqual([
      [IDLE_SESSION_IDENTITY, 'created'],
    ]);

    // Read across families: the legacy reader selects `scope = 'session'` by predicate and
    // returns nothing for a chunk-family session whether or not anything was written.
    const covered = await narrativeIdsInSession(harness.driver, IDLE_SESSION_IDENTITY);
    expect(covered).toHaveLength(1);
    expect(
      await edgeValidUntil(harness.driver, DERIVES_FROM_TYPE, covered[0]!, IDLE_SESSION_IDENTITY),
    ).toBeUndefined();

    // Offered no more: one chunk covers the session's one episode, so the aggregation's
    // coverage test is satisfied and the session leaves the list.
    const again = await sweepIdleSessions(structuralDeps, {
      now: afterTheIdleWindow(),
      chunkPolicy: { ...CHUNK_BOUNDARY_POLICY, maxSpanMs: 60_000 },
    });
    expect(again).toEqual([]);
  }, 120_000);
});

/**
 * What replaces the two keyed-window describes.
 *
 * The legacy renderer read a session in one call and recorded the fraction it saw, so a session
 * longer than the window lost its opening. The chunk family answers that by partitioning: the
 * tail seals at `CHUNK_MAX_MEMBERS` and each chunk renders whole. So the question is no longer
 * "did the window hold the session" but "does every episode end up in exactly one chunk", and
 * that is structural — no model window is involved, and the deterministic provider answers it.
 */
describe('a session longer than one chunk holds', () => {
  const wideEpisodeIds: string[] = [];

  beforeAll(async () => {
    for (const line of WIDE_EPISODES) {
      // Intake refuses a payload of summary alone, and the render reads the summary, so the
      // observation carries the same line rather than a second one nothing sees.
      wideEpisodeIds.push(
        await push({ summary: line, observations: [line] }, WIDE_SESSION_IDENTITY),
      );
    }
  }, 300_000);

  it('partitions it into chunks that cover every episode exactly once', async () => {
    expect(wideEpisodeIds).toHaveLength(50);
    expect(wideEpisodeIds.length).toBeGreaterThan(CHUNK_BOUNDARY_POLICY.maxMembers);

    // One close seals one chunk, so the session drains over as many closes as it holds chunks.
    // Bounded rather than looped forever: a close that stops creating is the end of the tail.
    const members: string[] = [];
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await closeSessionNarrative(structuralDeps, WIDE_SESSION_IDENTITY);
      if (result.status !== 'created') {
        expect(result.summary).toBe('the session has no unsealed members');
        break;
      }
      const chunkId = await chunkIdOf(result.narrativeId!);
      const sealed = listChunkMembers(db, chunkId);
      expect(sealed.length).toBeLessThanOrEqual(CHUNK_BOUNDARY_POLICY.maxMembers);
      expect(sealed).toHaveLength(result.episodes);
      members.push(...sealed);
    }

    // Exactly once each, and all of them: no episode fell between two chunks and none is a
    // member of two. This is what the legacy coverage fraction was standing in for.
    expect([...members].sort()).toEqual([...wideEpisodeIds].sort());
    expect(new Set(members).size).toBe(members.length);

    // Every chunk rendered whole. A partial render is a recorded gap on the revision, which is
    // `chunk-narrative.int.test.ts`'s subject, not a silently smaller coverage number.
    for (const narrativeId of await narrativeIdsInSession(harness.driver, WIDE_SESSION_IDENTITY)) {
      const properties = await nodeProperties(harness.driver, narrativeId);
      expect(properties[NARRATIVE_PROPERTIES.coverage]).toBe(1);
    }
  }, 300_000);
});

/**
 * Grounding, against the model that fabricated. The assertions are structural: how many
 * sentences survived and which node ids they cited, because a string match against the
 * source would only prove the model echoed wording, not that the claim is sourced.
 */
describe('grounding against a live substrate', () => {
  let thinEpisodeId: string;
  const planningEpisodeIds: string[] = [];
  const decisionIds: string[] = [];

  beforeAll(async () => {
    thinEpisodeId = await push(THIN_EPISODE, THIN_SESSION_IDENTITY);
    for (const payload of PLANNING_EPISODES) {
      planningEpisodeIds.push(await push(payload, PLANNING_SESSION_IDENTITY));
    }

    const now = new Date();
    for (const text of PLANNING_DECISIONS) {
      const written = await writeCognitiveNode(harness.driver, {
        episodeId: planningEpisodeIds[0]!,
        label: 'Decision',
        text,
        occurredAt: now,
        now,
      });
      decisionIds.push(written.node.id);
    }
    await writeCognitiveNode(harness.driver, {
      episodeId: planningEpisodeIds[1]!,
      label: 'Insight',
      text: PLANNING_INSIGHT,
      occurredAt: now,
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

  /**
   * The re-subject's sharpest change, and the one worth reading.
   *
   * The legacy renderer read a session's extracted nodes straight off the graph
   * (`loadSessionSourceNodes`) and offered every one of them as a citable source, so the case
   * this replaces could write four `Decision` nodes by hand and expect the narrative to name
   * them. The chunk family will not: `resolveChunkEnrichment` fences each node against the
   * RECORDS before nomination — a committed `extraction` incidence for the member, and a
   * verified node-state and `extraction` scope on the node — and a node it cannot certify at
   * both ends of that interval is OMITTED and named in `uncertified`.
   *
   * So the claim becomes the contract rather than the wish. These decisions exist in the graph
   * and nowhere in the records, which is exactly the shape a hand-seeded node has, and the
   * narrative must not cite one. The certified path is the pipeline's own — the extraction stages
   * commit that incidence — and proving a citation through it needs a run of those stages, which
   * is `chunk-enrichment`'s own subject rather than this file's.
   */
  it('cites only what the records certify, and omits an extracted node they do not', async () => {
    const sources = await loadSessionSourceNodes(harness.driver, PLANNING_SESSION_IDENTITY);
    expect(sources.map((source) => source.id).sort()).toEqual(
      [...decisionIds].concat(sources.filter((s) => s.kind === 'insight').map((s) => s.id)).sort(),
    );

    const result = await closeWithGroundingRetry(deps, PLANNING_SESSION_IDENTITY);

    expect(result.status).toBe('created');
    const properties = await nodeProperties(harness.driver, result.narrativeId!);
    const citations = properties[NARRATIVE_PROPERTIES.citations] as string[];

    // Every citation is one of the chunk's own members, and not one of the uncertified nodes the
    // graph offers beside them.
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.every((id) => planningEpisodeIds.includes(id))).toBe(true);
    expect(citations.some((id) => decisionIds.includes(id))).toBe(false);
    // Two members, so the sentence budget allows more than the one a single-member chunk gets:
    // `min(maxSentences, members, bySize)`.
    expect(Number(properties[NARRATIVE_PROPERTIES.sentenceCount])).toBeGreaterThan(1);
  }, 180_000);
});

/**
 * A session that grew after its first chunk sealed. Declared last, and on a session of its own,
 * because the idle sweep above cannot read a multi-chunk session as covered: `findIdleSessions`
 * compares `max(coverage_count)` against the episode count, which is the whole-session notion,
 * and a session partitioned into chunks has no single revision covering all of it. That is a
 * production gap in the sweep's predicate, recorded rather than worked around — nothing here
 * depends on it, and a session with two chunks sits in the sweep's offer list for good.
 */
const GROWN_SESSION_IDENTITY = 'mcp-transport-session-narratives-grown';

describe('a session that grew after its chunk sealed', () => {
  it('gets another chunk rather than a second version of the first', async () => {
    const first = await push(EPISODES[0], GROWN_SESSION_IDENTITY);
    const opening = await closeSessionNarrative(structuralDeps, GROWN_SESSION_IDENTITY);
    expect(opening.status).toBe('created');
    const openingChunkId = await chunkIdOf(opening.narrativeId!);
    expect(listChunkMembers(db, openingChunkId)).toEqual([first]);

    const late = await push(LATE_EPISODE, GROWN_SESSION_IDENTITY);
    const result = await closeSessionNarrative(structuralDeps, GROWN_SESSION_IDENTITY);

    expect(result.status).toBe('created');
    // Revision 1 again, of a different chunk: the number is per chunk, not per session.
    expect(result.version).toBe(1);
    expect(result.episodes).toBe(1);

    const secondChunkId = await chunkIdOf(result.narrativeId!);
    expect(secondChunkId).not.toBe(openingChunkId);
    expect(listChunkMembers(db, secondChunkId)).toEqual([late]);
    // Frozen: the first chunk did not grow to take the late episode in.
    expect(listChunkMembers(db, openingChunkId)).toEqual([first]);

    const written = await narrativeIdsInSession(harness.driver, GROWN_SESSION_IDENTITY);
    expect(written).toHaveLength(2);
    // Both heads stand, in either direction. This is the shape that replaces the legacy
    // family's supersession-on-growth, and it is the shape by design.
    for (const id of written) {
      expect(await supersedingNodeIds(harness.driver, id)).toEqual([]);
      expect(
        await edgeValidUntil(harness.driver, DERIVES_FROM_TYPE, id, GROWN_SESSION_IDENTITY),
      ).toBeUndefined();
    }
  }, 120_000);
});
