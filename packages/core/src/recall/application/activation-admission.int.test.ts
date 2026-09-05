import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
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
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The traversal leg, measured. Three episodes share one session, and only one of them names
 * the query's subject, so the other two are reachable exclusively by the spread: episode to
 * session to episode. One of the two answers the query and one does not, and the whole point
 * of the fixture is that the pack tells them apart on evidence rather than on how they were
 * found.
 */

const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';
const WRITE_SESSION = 'arrival-session-write';
const READ_SESSION = 'arrival-session-read';

const STARTED_AT = new Date('2026-06-01T09:00:00.000Z');
const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

const QUERY = 'why did we pick webhooks for ingestion';
const CUE = 'webhooks';

/** Names the subject, so every retrieval leg finds it. The only seed the run gets. */
const ANCHOR_TEXT = 'we picked webhooks for the ingestion service because polling was too slow';

/** Answers the query without naming its subject: no leg finds it, and it measures over the floor. */
const ANSWER_TEXT = 'the retry backoff doubles after each failed delivery attempt';

/** Reachable exactly as far as the answer is, and about nothing the query asked. */
const UNRELATED_TEXT = 'the quarterly planning meeting moved to thursday';

function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

/**
 * Three positions rather than two, so "measures over the floor" and "is found by a leg" are
 * independent properties of the fixture. The answer sits at cosine 0.707 to the cue, over the
 * 0.6 admission floor and under the anchor, so a k-of-1 vector search never returns it.
 */
function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  if (lowered.includes('webhook')) {
    return axis(0);
  }
  if (lowered.includes('backoff')) {
    const blended = [...axis(0)];
    blended[2] = 1;
    return blended;
  }
  return axis(1);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

/**
 * One seed and one row per cue per leg. The narrow budget is what isolates the spread: with
 * the shipped budget the vector leg returns the answer directly and the run stops proving
 * anything about traversal.
 *
 * Both session subtractions are off: every test recalls the same query in the same session, and
 * what is measured is what the spread reaches rather than what that session already holds.
 */
function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, vectorLimit: 1, sessionDedup: false, ownSessionFilter: false },
    contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 1 },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let deps: RecallDeps;
let answerEpisodeId: string;
let anchorEpisodeId: string;
let unrelatedEpisodeId: string;

async function push(observation: string, now: Date): Promise<string> {
  const result = await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions: deps.sessions,
      provider,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
      acceptHookCapture: true,
    },
    { observations: [observation] },
    { identity: WRITE_SESSION, now },
  );
  return result.episode_id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-arrival-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  deps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider,
    config: config(),
    cueCache: new CueCache(),
    logger,
  };

  // The anchor is written last so it is also the newest node: the recency leg reads one row at
  // this budget, and a recency hit on the answer would seed what the spread is supposed to find.
  answerEpisodeId = await push(ANSWER_TEXT, STARTED_AT);
  unrelatedEpisodeId = await push(UNRELATED_TEXT, new Date(STARTED_AT.getTime() + 60_000));
  anchorEpisodeId = await push(ANCHOR_TEXT, new Date(STARTED_AT.getTime() + 120_000));

  await waitFor('the vector index to cover every episode', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(1),
      limit: 10,
      mode: withCurrency(),
    });
    return rows.length >= 3;
  });

  await waitFor('the fulltext index to cover the anchor episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === anchorEpisodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('an episode only the spread can reach', () => {
  function recall(): Promise<Awaited<ReturnType<typeof handleRecall>>> {
    return handleRecall(deps, { query: QUERY }, { identity: READ_SESSION, now: RECALLED_AT });
  }

  /** The claim is worth nothing unless no direct leg could have produced the answer. */
  it('is out of reach of every retrieval leg at this budget', async () => {
    const nearest = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: config().recall.vectorLimit,
      mode: withCurrency(),
    });
    expect(nearest.map((row) => row.id)).toEqual([anchorEpisodeId]);

    const lexical = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    expect(lexical.map((row) => row.id)).not.toContain(answerEpisodeId);
  });

  it('reaches the pack on its own measured cosine, explained by the path that found it', async () => {
    const pack = await recall();

    const answer = pack.episodes?.find((item) => item.id === answerEpisodeId);
    expect(answer?.content).toContain(ANSWER_TEXT);
    expect(answer?.rationale.method).toBe('activation');
    expect(answer?.rationale.path).toContain('-[PARTICIPATES_IN]->');
    // The cosine admits it, so the pack can print a confidence for it: the activation score
    // ranks it and never stands in for a measurement.
    expect(answer?.confidence).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('leaves the equally reachable episode the query is not about outside the pack', async () => {
    const pack = await recall();

    expect(pack.episodes?.map((item) => item.id)).not.toContain(unrelatedEpisodeId);
    // Refused on a measurement rather than for want of one, which is the counter that used to
    // absorb every node the spread reached.
    expect(pack.metadata.admission.dropped_below_floor).toBeGreaterThan(0);
    expect(pack.metadata.admission.dropped_unmeasured).toBe(0);
  });

  it('still explains the seeded episode by the leg that found it', async () => {
    const pack = await recall();

    const anchor = pack.episodes?.find((item) => item.id === anchorEpisodeId);
    expect(anchor).toBeDefined();
    expect(anchor?.rationale.method).not.toBe('activation');
  });
});
