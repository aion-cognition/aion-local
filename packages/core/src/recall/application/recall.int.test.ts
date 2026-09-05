import { packBuckets } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone, SUBSTRATE_NAME } from '../../infrastructure/graph/backbone.js';
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
import { getLastPack } from '../../infrastructure/sqlite/last-pack.js';
import {
  PACK_METHODS,
  packMethodCounters,
  type PackMethod,
} from '../../infrastructure/sqlite/method-counters.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { orchestratorLedgerKey } from '../../reflection/application/orchestrator.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';

const EMBED_DIMENSION = 8;
const WRITE_SESSION = 'recall-int-write-session';
const READ_SESSION = 'recall-int-read-session';

const UNRELATED_AT = new Date('2026-06-01T10:00:00.000Z');
const WEBHOOKS_AT = new Date('2026-06-01T11:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');
/** Before either episode was recorded, so a knowledge-time read sees the substrate empty. */
const BEFORE_ANYTHING = '2026-05-01T00:00:00.000Z';

const WEBHOOKS_OBSERVATION =
  'we picked webhooks for the ingestion service because polling was too slow';
const UNRELATED_OBSERVATION = 'the standup moved to nine thirty on tuesdays';

const QUERY = 'why did we pick webhooks for ingestion';
const CUE = 'webhooks';

function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

/**
 * Deterministic stand-in for the embedding model: the topic decides the axis, so "reachable
 * only by traversal" is a property of the fixture graph rather than of whatever a live
 * model happened to score. Cue extraction is stubbed for the same reason: unit and
 * integration tests here prove the pipeline, never the model's judgment.
 */
function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  if (lowered.includes('webhook')) {
    return axis(0);
  }
  if (lowered.includes('standup')) {
    return axis(1);
  }
  return axis(2);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

/**
 * One seed and one vector hit per cue. The narrow budget is the point: a wide one would let
 * every fixture node in as a direct hit and there would be nothing left for traversal to be
 * the only path to.
 *
 * Both session subtractions are off throughout. Every test here asks the same question of the
 * same reading session, and what each one measures is what the substrate answers rather than
 * what that session has already been handed or wrote itself.
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
let sessions: SessionManager;
let deps: RecallDeps;
let webhooksEpisodeId: string;
let unrelatedEpisodeId: string;
let substrateId: string;

async function push(
  observation: string,
  now: Date,
  identity: string = WRITE_SESSION,
): Promise<string> {
  const result = await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions,
      provider,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
      acceptHookCapture: true,
    },
    { observations: [observation] },
    { identity, now },
  );
  return result.episode_id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-recall-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  substrateId = backbone.substrate.id;
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

  // The unrelated episode is stored first so the recency strategy ranks the webhooks one
  // ahead of it, which keeps the unrelated episode out of every seed list.
  unrelatedEpisodeId = await push(UNRELATED_OBSERVATION, UNRELATED_AT);
  webhooksEpisodeId = await push(WEBHOOKS_OBSERVATION, WEBHOOKS_AT);

  await waitFor('the vector index to cover both episodes', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: 10,
      mode: withCurrency(),
    });
    return rows.length >= 2;
  });

  await waitFor('the fulltext index to cover the webhooks episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === webhooksEpisodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('recall over a substrate written by the real intake path', () => {
  it('returns the episode the query is about, explained by the strategy that found it', async () => {
    const pack = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    const hit = pack.episodes?.find((item) => item.id === webhooksEpisodeId);
    expect(hit?.content).toContain(WEBHOOKS_OBSERVATION);
    expect(['vector', 'bm25', 'recency']).toContain(hit?.rationale.method);
    expect(hit?.currency).toBe('current');
  });

  /**
   * The spread still reaches it and reinforcement still counts it; what changed is that
   * reaching a node is no longer a reason to serve it. This episode shares a session with the
   * one the query is about and nothing else, which is exactly the shape that filled the
   * exercise's off-topic packs to budget: one hit clears the floor and the whole activation
   * spread rides in behind it. It is scored against the query like any other candidate, and
   * what keeps it out is the answer that scoring gives.
   */
  it('refuses an episode the spread reached that measures nothing like the query', async () => {
    const pack = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    expect(pack.episodes?.map((item) => item.id)).toEqual([webhooksEpisodeId]);
    // Refused, and said so: a pack this thin has to be readable as a floor doing its job.
    expect(pack.metadata.admission.dropped_below_floor).toBeGreaterThan(0);

    // The claim only means something if no direct leg could have produced it.
    const direct = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: 1,
      mode: withCurrency(),
    });
    expect(direct.map((row) => row.id)).toEqual([webhooksEpisodeId]);
    const lexical = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    expect(lexical.map((row) => row.id)).not.toContain(unrelatedEpisodeId);
  });

  it('renders what it served and persists it under the reading session', async () => {
    const started = performance.now();
    const pack = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );
    const elapsed = performance.now() - started;

    expect(pack.rendered_text).toContain('## Episodes');
    expect(pack.rendered_text).toContain(WEBHOOKS_OBSERVATION);
    // The caller's own question leads the cue set, ahead of whatever the model extracted.
    expect(pack.metadata.cues).toEqual([
      { text: QUERY, source: 'query', weight: 3 },
      { text: CUE, source: 'query', weight: 3 },
    ]);
    expect(pack.metadata.token_estimate).toBeGreaterThan(0);
    const timings = pack.metadata.stage_timings_ms;
    for (const stage of ['cues', 'embed', 'seeds', 'activation', 'fusion'] as const) {
      expect(timings[stage]).toBeGreaterThanOrEqual(0);
    }
    // Sequential stages inside one call, so the sum is bounded by the call: against a real
    // server and a real model this is the reading that says the spans are spans.
    const spent = Object.values(timings).reduce((total, ms) => total + ms, 0);
    expect(spent).toBeLessThanOrEqual(elapsed);

    expect(getLastPack(db, READ_SESSION)?.pack).toEqual(pack);
  });

  it('returns an explicitly empty pack when the substrate held nothing yet', async () => {
    const pack = await handleRecall(
      deps,
      { query: QUERY, knew_at: BEFORE_ANYTHING },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    expect(pack.facts).toBeUndefined();
    expect(pack.episodes).toBeUndefined();
    expect(pack.narratives).toBeUndefined();
    expect(pack.preferences).toBeUndefined();
    expect(pack.resonant).toBeUndefined();
    expect(pack.rendered_text).toContain('No memories matched this query.');
    expect(pack.metadata.cues).toHaveLength(2);
  });

  /**
   * The substrate node answers to its own name, so a cue naming it resolves it as a seed. It
   * is connectivity rather than something a person said, and the structural drop is what keeps
   * it out of every bucket.
   */
  it('never serves the substrate node itself, however a cue names it', async () => {
    const namingSubstrate: RecallDeps = {
      ...deps,
      provider: {
        embed: (texts) => provider.embed(texts),
        generate: () =>
          Promise.resolve({ query_cues: [SUBSTRATE_NAME], summary_cues: [], recent_turn_cues: [] }),
      },
      cueCache: new CueCache(),
    };

    const pack = await handleRecall(
      namingSubstrate,
      { query: `what is ${SUBSTRATE_NAME}` },
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    const served = Object.values(packBuckets(pack)).flatMap((items) =>
      items.map((item) => item.id),
    );
    expect(served).not.toContain(substrateId);
    expect(pack.rendered_text).not.toContain(SUBSTRATE_NAME);
  });
});

describe('pending_enrichment metadata', () => {
  const PENDING_SESSION = 'recall-int-pending-session';
  const PENDING_AT = new Date('2026-06-03T09:00:00.000Z');

  it("counts the calling session's own episodes with no orchestrator ledger key", async () => {
    await push('first pending observation', PENDING_AT, PENDING_SESSION);
    const second = await push('second pending observation', PENDING_AT, PENDING_SESSION);
    await push('third pending observation', PENDING_AT, PENDING_SESSION);

    // Only `second` is marked enriched; the orchestrator never runs in this file, so the
    // other two stay open the way a fresh episode always does before the worker reaches it.
    markLedgerApplied(db, orchestratorLedgerKey(PIPELINE_VERSION, second));

    const pack = await handleRecall(
      deps,
      { query: 'pending observation' },
      {
        identity: PENDING_SESSION,
        now: PENDING_AT,
      },
    );

    expect(pack.metadata.pending_enrichment).toBe(2);
  });

  it("omits pending_enrichment once every one of the session's episodes is enriched", async () => {
    const session = 'recall-int-fully-enriched-session';
    const episodeId = await push('a fully enriched observation', PENDING_AT, session);
    markLedgerApplied(db, orchestratorLedgerKey(PIPELINE_VERSION, episodeId));

    const pack = await handleRecall(
      deps,
      { query: 'fully enriched observation' },
      {
        identity: session,
        now: PENDING_AT,
      },
    );

    expect(pack.metadata.pending_enrichment).toBeUndefined();
  });
});

describe('per-method pack contribution counters', () => {
  it('accumulates across separate recalls rather than resetting on each one', async () => {
    const before = packMethodCounters(db);

    const first = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );
    const second = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    const after = packMethodCounters(db);
    // Only the methods the counter tracks: `graph_traversal` is the fusion leg's name and no
    // item carries it, so it is not a counter row.
    const methods = [...(first.episodes ?? []), ...(second.episodes ?? [])]
      .map((item) => item.rationale.method)
      .filter((method): method is PackMethod =>
        (PACK_METHODS as readonly string[]).includes(method),
      );
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(after[method]).toBeGreaterThan(before[method]);
    }
  });
});
