import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { ENTITY_MENTION_TYPE } from '../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { fulltextSeeds, vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import { contextVector } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { ContextVectorStage } from '../../reflection/application/stages/context-vectors.js';
import type { StageContext } from '../../reflection/domain/stage.js';
import { SessionManager } from '../../session/session-manager.js';
import { RESONANCE_PATH } from '../domain/resonance.js';
import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { resonate } from './resonance.js';

/**
 * The mechanism the whitepaper describes, built as its own scenario. Two memories that share
 * no words: one names the query's subject, the other is about something else entirely. What
 * they have in common is the shape of their neighborhoods, because each sits next to an entity
 * whose own embedding is nearly the other's. That is the whole claim of context resonance, and
 * the assertion is that the second memory reaches the pack through the resonant bucket and
 * through no other route.
 *
 * The graph is hand-built rather than extracted by a model, for the reason the context-vector
 * stage's own live test gives: what needs proving here is the Cypher, the index and the
 * centroid, not extraction quality. The context vectors themselves are computed by the shipped
 * stage from the neighborhoods below, never written by the fixture.
 */

const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';
const READ_SESSION = 'resonance-session-read';

const AT = new Date('2026-06-01T09:00:00.000Z');
const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

const QUERY = 'why did we pick webhooks for ingestion';
const OFF_TOPIC_QUERY = 'monsoon rainfall variability across Tamil Nadu districts';

const ANCHOR_ID = 'resonance-anchor';
const SIBLING_ID = 'resonance-sibling';
const TARGET_ID = 'resonance-target';
const DISTRACTOR_ID = 'resonance-distractor';
const ACTIVE_TEAM_ID = 'resonance-active-team';
const QUIET_TEAM_ID = 'resonance-quiet-team';
const OTHER_TEAM_ID = 'resonance-other-team';

const ANCHOR_TEXT = 'we picked webhooks for the ingestion service because polling was too slow';
const SIBLING_TEXT = 'the webhooks rollout shipped behind a flag on the ingestion path';
/** Nothing in this sentence is in the query, and its content vector is orthogonal to the cue. */
const TARGET_TEXT = 'the seating plan for the offsite put the two new hires at the same table';
const DISTRACTOR_TEXT = 'the espresso machine on the third floor needs descaling every fortnight';

/**
 * Small, fractional components only. The vector index property is FLOAT-typed and a
 * whole-number JS value risks the driver encoding it as a Cypher INTEGER, so no component is
 * ever exactly zero or one.
 */
function unit(components: Readonly<Record<number, number>>): Vector {
  const raw = new Array<number>(EMBED_DIMENSION).fill(0.001);
  for (const [index, value] of Object.entries(components)) {
    raw[Number(index)] = value;
  }
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

/** The query's subject. The anchor is about it; nothing else in the graph is. */
const SUBJECT = unit({ 0: 0.99 });
/** Also about the subject, so it anchors too, but never the nearest hit. */
const SIBLING_CONTENT = unit({ 0: 0.8, 6: 0.6 });
/** The target's and the distractor's subjects, each orthogonal to the query's. */
const OFFSITE = unit({ 1: 0.99 });
const ESPRESSO = unit({ 2: 0.99 });

/**
 * The two team entities are different nodes with near-identical embeddings: the same shape of
 * working relationship around two unrelated pieces of work. Their similarity is what a context
 * vector carries and what the second pass searches on.
 */
const ACTIVE_TEAM_CONTENT = unit({ 3: 0.99 });
const QUIET_TEAM_CONTENT = unit({ 3: 0.97, 7: 0.24 });
/** A third shape, so the distractor is unrelated by neighborhood as well as by content. */
const OTHER_TEAM_CONTENT = unit({ 5: 0.99 });

function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  if (lowered.includes('webhook') || lowered.includes('ingestion')) {
    return SUBJECT;
  }
  if (lowered.includes('offsite') || lowered.includes('seating')) {
    return OFFSITE;
  }
  if (lowered.includes('espresso')) {
    return ESPRESSO;
  }
  return unit({ 4: 0.99 });
}

/** The query text as the cue model would hand it back: one query cue, the caller's own words. */
function queryOf(request: StructuredRequest): string {
  const user = request.messages.find((message) => message.role === 'user');
  const match = /Query:\n(.*)/.exec(user?.content ?? '');
  return match?.[1]?.trim() ?? '';
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: (request) =>
    Promise.resolve({
      query_cues: [queryOf(request)],
      summary_cues: [],
      recent_turn_cues: [],
    }),
};

/**
 * One seed and one row per cue per leg. The narrow budget is what isolates the second pass: at
 * the shipped budget every node in a graph this small is a seed, the exclusion set swallows the
 * whole substrate, and the run proves nothing about resonance.
 */
function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, vectorLimit: 1 },
    contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 1 },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let deps: RecallDeps;

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

async function writeEpisode(id: string, text: string, vector: Vector, at: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: at,
    occurredAt: at,
    properties: { text, session_id: `${id}-session`, content_vec: [...vector] },
  });
}

async function writeTeam(id: string, name: string, vector: Vector): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: AT,
    occurredAt: AT,
    properties: {
      name,
      name_norm: name.toLowerCase(),
      type: 'group',
      text: name,
      content_vec: [...vector],
    },
  });
}

async function mention(episodeId: string, entityId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: ENTITY_MENTION_TYPE,
    sourceId: episodeId,
    targetId: entityId,
    strength: 1,
    confidence: 0.9,
    signals: ['episodic'],
    provenance: ['test-fixture'],
    count: 1,
    now: AT,
  });
}

function stageContext(episodeId: string, text: string): StageContext {
  return {
    driver: harness.driver,
    db,
    provider,
    episodeId,
    episode: {
      id: episodeId,
      sessionId: `${episodeId}-session`,
      text,
      occurredAt: AT,
      turns: [],
    },
    logger,
    now: AT,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-resonance-int-'));
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

  await writeTeam(ACTIVE_TEAM_ID, 'the ingestion crew', ACTIVE_TEAM_CONTENT);
  await writeTeam(QUIET_TEAM_ID, 'the onboarding crew', QUIET_TEAM_CONTENT);
  await writeTeam(OTHER_TEAM_ID, 'the office managers', OTHER_TEAM_CONTENT);

  // The anchor is written last so it is also the newest node: the recency leg reads one row at
  // this budget, and a recency hit on anything else would seed what the spread and the second
  // pass are supposed to find on their own.
  await writeEpisode(TARGET_ID, TARGET_TEXT, OFFSITE, AT);
  await writeEpisode(DISTRACTOR_ID, DISTRACTOR_TEXT, ESPRESSO, new Date(AT.getTime() + 60_000));
  await writeEpisode(SIBLING_ID, SIBLING_TEXT, SIBLING_CONTENT, new Date(AT.getTime() + 120_000));
  await writeEpisode(ANCHOR_ID, ANCHOR_TEXT, SUBJECT, new Date(AT.getTime() + 180_000));

  await mention(ANCHOR_ID, ACTIVE_TEAM_ID);
  await mention(SIBLING_ID, ACTIVE_TEAM_ID);
  await mention(TARGET_ID, QUIET_TEAM_ID);
  await mention(DISTRACTOR_ID, OTHER_TEAM_ID);

  await waitFor('the vector index to cover every episode', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: SUBJECT,
      limit: 20,
      mode: withCurrency(),
    });
    return rows.length >= 7;
  });

  await waitFor('the fulltext index to cover the anchor episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: 'webhooks',
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === ANCHOR_ID);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function recall(query = QUERY): Promise<Awaited<ReturnType<typeof handleRecall>>> {
  return handleRecall(deps, { query }, { identity: READ_SESSION, now: RECALLED_AT });
}

function activationOf(...ids: readonly string[]): { nodeId: string; score: number; hops: number; pathSummary: string }[] {
  return ids.map((nodeId, index) => ({
    nodeId,
    score: 1 - index * 0.1,
    hops: index,
    pathSummary: '(seed)',
  }));
}

/**
 * Before any context vector exists. The substrate is otherwise complete, so this is the cold
 * start the whitepaper names: a graph whose nodes are real and whose neighborhoods have not
 * been summarized yet.
 */
describe('a substrate with no context vectors written yet', () => {
  it('serves a pack with no resonant bucket and still times the stage', async () => {
    const pack = await recall();

    expect(pack.resonant).toBeUndefined();
    expect(pack.metadata.stage_timings_ms.resonance).toBeGreaterThanOrEqual(0);
  });

  it('says the stage skipped for want of context vectors rather than searching on nothing', async () => {
    const result = await resonate(
      { driver: harness.driver, config: config(), logger },
      {
        activated: activationOf(ANCHOR_ID, ACTIVE_TEAM_ID),
        exclude: new Set([ANCHOR_ID, ACTIVE_TEAM_ID]),
        anchored: true,
        mode: withCurrency(),
      },
    );

    expect(result.skipped).toBe('no_context_vectors');
    expect(result.covered).toBe(0);
  });
});

describe('once reflection has summarized every neighborhood', () => {
  beforeAll(async () => {
    for (const [id, text] of [
      [ANCHOR_ID, ANCHOR_TEXT],
      [SIBLING_ID, SIBLING_TEXT],
      [TARGET_ID, TARGET_TEXT],
      [DISTRACTOR_ID, DISTRACTOR_TEXT],
    ] as const) {
      const outcome = await new ContextVectorStage().run(stageContext(id, text));
      expect(outcome.status).toBe('ok');
    }

    await waitFor('the context vector index to cover every episode', async () => {
      for (const id of [ANCHOR_ID, SIBLING_ID, TARGET_ID, DISTRACTOR_ID]) {
        if ((await contextVector(harness.driver, id)) === undefined) {
          return false;
        }
      }
      return true;
    });
    // The index is eventually consistent; a probe that runs while it catches up measures lag.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 120_000);

  /** The claim is worth nothing unless the target is genuinely out of reach of the first pass. */
  it('leaves the target unreachable by content, by keyword and by the spread', async () => {
    const nearest = await vectorSeeds(harness.driver, {
      vector: SUBJECT,
      limit: config().recall.vectorLimit,
      mode: withCurrency(),
    });
    expect(nearest.map((row) => row.id)).toEqual([ANCHOR_ID]);

    const lexical = await fulltextSeeds(harness.driver, {
      query: 'webhooks ingestion',
      limit: 10,
      mode: withCurrency(),
    });
    expect(lexical.map((row) => row.id)).not.toContain(TARGET_ID);
  });

  it('surfaces the target in the resonant bucket and nowhere else', async () => {
    const pack = await recall();

    expect(pack.resonant?.map((item) => item.id)).toEqual([TARGET_ID]);
    expect(pack.episodes?.map((item) => item.id) ?? []).not.toContain(TARGET_ID);
    expect(pack.facts?.map((item) => item.id) ?? []).not.toContain(TARGET_ID);
    expect(pack.narratives).toBeUndefined();
  });

  it('explains it as a shape match and prints the context similarity as its confidence', async () => {
    const pack = await recall();
    const found = pack.resonant?.[0];

    expect(found?.content).toContain('seating plan');
    expect(found?.rationale.method).toBe('resonance');
    expect(found?.rationale.path).toBe(RESONANCE_PATH);
    // Above the whitepaper's 0.7 bar, which is what admitted it: the same node's content
    // cosine against the query cue is near zero.
    expect(found?.confidence).toBeGreaterThanOrEqual(
      config().contextResonance.contextSearchThreshold,
    );
  });

  it('leaves the memory whose neighborhood has a different shape out of the pack', async () => {
    const pack = await recall();

    for (const bucket of [pack.resonant, pack.episodes, pack.facts]) {
      expect(bucket?.map((item) => item.id) ?? []).not.toContain(DISTRACTOR_ID);
    }
  });

  it('still answers the query directly, so the second pass is an addition and not a swap', async () => {
    const pack = await recall();

    expect(pack.episodes?.map((item) => item.id)).toContain(ANCHOR_ID);
    expect(pack.metadata.admission.admitted).toBeGreaterThan(0);
  });

  // The measurement the plan asks for: how much of the activated set had been through
  // reflection's last stage when the second pass ran.
  it('reports how much of the activated set carried a context vector', async () => {
    const result = await resonate(
      { driver: harness.driver, config: config(), logger },
      {
        activated: activationOf(ANCHOR_ID, ACTIVE_TEAM_ID, SIBLING_ID),
        exclude: new Set([ANCHOR_ID, ACTIVE_TEAM_ID, SIBLING_ID]),
        anchored: true,
        mode: withCurrency(),
      },
    );

    console.log(
      `context vector coverage: ${String(result.covered)}/${String(result.activated)} activated nodes, ` +
        `${String(result.items.length)} resonant item(s)`,
    );
    expect(result.covered).toBe(3);
  });

  /**
   * Resonance cannot fire on a query the first pass could not answer. The centroid would be the
   * shape of whatever the recency leg returned, and searching from it is how an off-topic pack
   * fills itself with memories nothing measured.
   */
  it('produces nothing for an off-topic query, which anchors nothing to resonate from', async () => {
    const pack = await recall(OFF_TOPIC_QUERY);

    expect(pack.resonant).toBeUndefined();
    // Nothing cleared the gate, which is the state the stage refuses to search from, and the
    // pack says so rather than looking like an empty substrate.
    expect(pack.metadata.admission.admitted).toBe(0);
    expect(
      pack.metadata.admission.dropped_below_floor + pack.metadata.admission.dropped_unmeasured,
    ).toBeGreaterThan(0);
  });
});

/** Turning the stage off has to cost the second pass and nothing else. */
describe('with context resonance disabled', () => {
  it('serves the same first-pass answer with no resonant bucket', async () => {
    const disabled: RecallDeps = {
      ...deps,
      config: {
        ...config(),
        recall: { ...config().recall, useContextResonance: false },
      },
      cueCache: new CueCache(),
    };

    const pack = await handleRecall(disabled, { query: QUERY }, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    expect(pack.resonant).toBeUndefined();
    expect(pack.episodes?.map((item) => item.id)).toContain(ANCHOR_ID);
  });
});

/** Reads the driver directly so the fixture's own claim about the graph is checked, not assumed. */
async function contextVectorsOf(driver: Driver, ids: readonly string[]): Promise<(Vector | undefined)[]> {
  const found: (Vector | undefined)[] = [];
  for (const id of ids) {
    found.push(await contextVector(driver, id));
  }
  return found;
}

describe('the fixture the claim rests on', () => {
  it('gives the anchor and the target near-identical context vectors from different neighbors', async () => {
    const [anchor, target] = await contextVectorsOf(harness.driver, [ANCHOR_ID, TARGET_ID]);

    expect(anchor).toBeDefined();
    expect(target).toBeDefined();
    // Each is its own single neighbor's content vector, and those two entities are distinct
    // nodes: the similarity is in the embeddings, never in a shared node.
    expect(anchor?.[3]).toBeGreaterThan(0.9);
    expect(target?.[3]).toBeGreaterThan(0.9);
  });
});
