import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone, GLOBAL_WORKSPACE_NAME } from '../../infrastructure/graph/backbone.js';
import { supersede } from '../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { fulltextSeeds, vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { ReflectionDispatch } from '../../reflection/application/dispatch.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { SessionManager } from '../../session/session-manager.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';

/**
 * A realistic substrate scale: 21 episodes across 3 chained sessions, most of them carrying
 * turns, written through the real intake path and read through `handleRecall` at the shipped
 * defaults. Stage-level tests can pass on a two-node fixture while the assembled pipeline
 * returns nothing at this size, which is the gap this file closes.
 *
 * Two behaviours the stage tests could not answer: an item reachable only through
 * FOLLOWS/backbone traversal, and supersession lineage under `as_of`.
 */

const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';

/** Oldest first; `SessionManager` chains each new identity to the previous one with FOLLOWS. */
const OLDEST_SESSION = 'gate-session-oldest';
const PRIOR_SESSION = 'gate-session-prior';
const CURRENT_SESSION = 'gate-session-current';
const READ_SESSION = 'gate-session-read';

const EPISODES_PER_OLD_SESSION = 10;

const STARTED_AT = new Date('2026-06-01T09:00:00.000Z');
const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

const QUERY = 'why did we pick webhooks for ingestion';
const CUE = 'webhooks';

const SEED_OBSERVATION =
  'we picked webhooks for the ingestion service because polling was too slow';

function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

/**
 * Topic decides the axis, so "reachable only by traversal" is a property of the fixture graph
 * rather than of whatever a live model scored. Only text naming webhooks sits on the cue's
 * axis; everything else, turns included, is orthogonal to it.
 */
function vectorFor(text: string): Vector {
  return text.toLowerCase().includes('webhook') ? axis(0) : axis(1);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

function config(): Config {
  return { ...DEFAULTS, models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION } };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
let deps: RecallDeps;
let seedEpisodeId: string;
let priorSessionEpisodeIds: string[];

async function waitFor(label: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

type PushInput = {
  readonly identity: string;
  readonly observation: string;
  readonly now: Date;
  /** Turn text never names the cue, so a turn is never a direct hit for it. */
  readonly withTurns?: boolean;
};

async function push(input: PushInput): Promise<string> {
  const result = await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions,
      provider,
      dispatch: new ReflectionDispatch(),
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    },
    {
      observations: [input.observation],
      ...(input.withTurns === true
        ? {
            turns: [
              { role: 'user', text: 'did we ever settle that one' },
              { role: 'assistant', text: 'yes, it is written up in the notes' },
            ],
          }
        : {}),
    },
    { identity: input.identity, now: input.now },
  );
  return result.episode_id;
}

async function fillSession(identity: string, label: string, startedAt: Date): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < EPISODES_PER_OLD_SESSION; index += 1) {
    ids.push(
      await push({
        identity,
        observation: `${label} decision number ${String(index)}`,
        now: new Date(startedAt.getTime() + index * 60_000),
        withTurns: true,
      }),
    );
  }
  return ids;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-recall-gate-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });

  deps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config: config(),
    cueCache: new CueCache(),
    logger,
  };

  await fillSession(OLDEST_SESSION, 'oldest', STARTED_AT);
  priorSessionEpisodeIds = await fillSession(
    PRIOR_SESSION,
    'prior',
    new Date(STARTED_AT.getTime() + 86_400_000),
  );
  // The newest session holds one episode, carrying the only content the query matches. It is
  // the only place the retrieval legs can start, which is what leaves the two older sessions
  // reachable by traversal alone.
  seedEpisodeId = await push({
    identity: CURRENT_SESSION,
    observation: SEED_OBSERVATION,
    now: new Date(STARTED_AT.getTime() + 172_800_000),
    withTurns: true,
  });

  await waitFor('the vector index to cover the substrate', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(1),
      limit: 25,
      mode: withCurrency(),
    });
    return rows.length >= EPISODES_PER_OLD_SESSION * 2;
  });

  await waitFor('the fulltext index to cover the seed episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === seedEpisodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('gate item 2: an item only traversal connects to the query', () => {
  /**
   * One seed, so every other item in the pack is something traversal alone reached. At the
   * default seed limit the recency strategy also seeds the older sessions directly, which
   * still exercises traversal but no longer isolates the session chain as the only path.
   */
  function narrowSeeding(): RecallDeps {
    return {
      ...deps,
      config: {
        ...config(),
        contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 1 },
      },
      cueCache: new CueCache(),
    };
  }

  /**
   * The FOLLOWS chain is still what makes a prior session reachable; what it no longer does is
   * admit. A memory the spread reached and no leg measured cannot be told apart from the
   * activation noise that filled the exercise's off-topic packs, so cross-session reach shows
   * up in the report rather than in the pack, and an older episode surfaces when a retrieval
   * leg measured it as well.
   */
  it('reaches prior sessions over the FOLLOWS chain without admitting on the reach alone', async () => {
    const pack = await handleRecall(narrowSeeding(), { query: QUERY }, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    expect(pack.metadata.admission.dropped_unmeasured).toBeGreaterThan(0);
    for (const item of pack.episodes ?? []) {
      expect(item.rationale.method).not.toBe('activation');
    }
  });

  /**
   * At the shipped seed limit the recency strategy also seeds the older sessions directly, and
   * a node it seeded is explained by recency rather than by the spread. Recency measures
   * nothing, so those items do not reach the pack: widening the seed set changes which of the
   * older episodes surface, never whether the pack is padded with merely-recent ones.
   */
  it('never pads the pack with a memory whose only claim is that it is recent', async () => {
    const pack = await handleRecall(deps, { query: QUERY }, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    expect(pack.episodes?.length).toBeGreaterThan(0);
    for (const item of pack.episodes ?? []) {
      expect(item.rationale.method).not.toBe('recency');
    }
  });

  it('proves no retrieval leg could have produced them', async () => {
    const direct = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: DEFAULTS.recall.vectorLimit,
      mode: withCurrency(),
    });
    expect(direct[0]?.id).toBe(seedEpisodeId);

    const lexical = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 25,
      mode: withCurrency(),
    });
    for (const id of priorSessionEpisodeIds) {
      expect(lexical.map((row) => row.id)).not.toContain(id);
    }
  });

  it('spends one episode slot on the seed and its own turns', async () => {
    const pack = await handleRecall(deps, { query: QUERY }, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    const fromSeedEpisode = (pack.episodes ?? []).filter(
      (item) => item.id === seedEpisodeId || item.content.includes(SEED_OBSERVATION),
    );
    expect(fromSeedEpisode).toHaveLength(1);
    expect(pack.episodes?.length).toBeLessThanOrEqual(DEFAULTS.recall.maxEpisodes);
  });

  it('keeps the backbone out of the pack entirely', async () => {
    const pack = await handleRecall(deps, { query: QUERY }, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    expect(pack.facts).toBeUndefined();
    expect(pack.rendered_text).not.toContain(MEMBER_NAME);
    expect(pack.rendered_text).not.toContain(GLOBAL_WORKSPACE_NAME);
  });
});

describe('gate item 5: supersession lineage through the whole pipeline', () => {
  const STALE_AT = new Date('2026-06-05T09:00:00.000Z');
  const CORRECTED_AT = new Date('2026-06-08T09:00:00.000Z');
  const BEFORE_CORRECTION = '2026-06-07T00:00:00.000Z';

  const STALE_FACT = 'the webhooks endpoint runs on the legacy ingestion host';
  const CORRECTION = 'the webhooks endpoint moved to the new ingestion host';

  let staleId: string;
  let correctionId: string;

  // Both turnless, so each is the only node in the graph carrying its text and the assertions
  // below can name an episode by id without a Turn standing in for it.
  beforeAll(async () => {
    staleId = await push({
      identity: CURRENT_SESSION,
      observation: STALE_FACT,
      now: STALE_AT,
    });
    correctionId = await push({
      identity: CURRENT_SESSION,
      observation: CORRECTION,
      now: CORRECTED_AT,
    });
    await supersede(harness.driver, { oldId: staleId, newId: correctionId, now: CORRECTED_AT });

    await waitFor('the correction to reach the fulltext index', async () => {
      const rows = await fulltextSeeds(harness.driver, {
        query: CUE,
        limit: 25,
        mode: withCurrency(),
      });
      return rows.some((row) => row.id === correctionId);
    });
  }, 120_000);

  it('ranks the current fact ahead of the one it replaced and marks the lineage', async () => {
    const pack = await handleRecall({ ...deps, cueCache: new CueCache() }, { query: QUERY }, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    const ids = (pack.episodes ?? []).map((item) => item.id);
    expect(ids).toContain(correctionId);
    expect(ids).toContain(staleId);
    expect(ids.indexOf(correctionId)).toBeLessThan(ids.indexOf(staleId));

    const stale = pack.episodes?.find((item) => item.id === staleId);
    expect(stale?.currency).toBe('superseded');
    expect(stale?.superseded_by?.id).toBe(correctionId);
    expect(pack.rendered_text).toContain(`superseded by ${correctionId}`);
  });

  it('returns the old truth as current-for-then under as_of, without the correction', async () => {
    const pack = await handleRecall(
      { ...deps, cueCache: new CueCache() },
      { query: QUERY, as_of: BEFORE_CORRECTION },
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    const ids = (pack.episodes ?? []).map((item) => item.id);
    expect(ids).toContain(staleId);
    expect(ids).not.toContain(correctionId);

    const then = pack.episodes?.find((item) => item.id === staleId);
    expect(then?.currency).toBe('current');
    // World time decides currency; the lineage is what the substrate knows now, and it knows
    // this was later replaced. `knew_at` is the mode that also rewinds the lineage.
    expect(then?.superseded_by?.id).toBe(correctionId);
  });

  it('hides the lineage as well under knew_at, which rewinds what the substrate knew', async () => {
    const pack = await handleRecall(
      { ...deps, cueCache: new CueCache() },
      { query: QUERY, knew_at: BEFORE_CORRECTION },
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    const then = pack.episodes?.find((item) => item.id === staleId);
    expect(then?.currency).toBe('current');
    expect(then?.superseded_by).toBeUndefined();
    expect((pack.episodes ?? []).map((item) => item.id)).not.toContain(correctionId);
  });
});
