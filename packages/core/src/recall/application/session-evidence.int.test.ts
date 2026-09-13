import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { RecallSideEffects } from './side-effects.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import * as provenanceQueries from '../../infrastructure/graph/claim-provenance-queries.js';
import {
  normalizeCognitiveText,
  TEXT_NORM_PROPERTY,
} from '../../infrastructure/graph/cognitive-queries.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import { accessMetadata } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import {
  directIntakePublisher,
  drainAcceptedVectors,
} from '../../reflection/test-support/direct-intake.fixture.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * What a session is told again after the substrate says something new about a memory it already
 * read, and what it is spared once nothing has moved.
 *
 * The graph is hand-built where the shape is the subject. Content vectors are written rather than
 * embedded: the subject is which memories cross the two serving-layer subtractions, not extraction
 * quality or the embedding model.
 */

const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';

const SEEDED_AT = new Date('2026-06-01T09:00:00.000Z');
const SUPERSEDED_AT = new Date('2026-06-05T09:00:00.000Z');
const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

const QUERY = 'how does the ingest queue drain';

const TURN_EPISODE_ID = 'evidence-turn-episode';
const TURN_ID = 'evidence-stale-turn';
const SUBJECT_ID = 'evidence-subject-entity';
const CLAIM_EPISODE_ID = 'evidence-claim-episode';
const FAMILY_CLAIM_ID = 'evidence-family-claim';
const REPLACEMENT_CLAIM_ID = 'evidence-replacement-claim';

const SUBJECT_NAME = 'ingest queue';
const TURN_TEXT = 'the ingest queue drains itself overnight without a worker';
/** Opens on its own words: the near-duplicate cap keys on the first sixteen characters. */
const FAMILY_CLAIM_TEXT = 'a worker is what drains the ingest queue, and nothing else does';
const REPLACEMENT_CLAIM_TEXT =
  'dedicated workers drain the ingest queue only during business hours';

/**
 * One strong shared component with the cue and one axis of its own, so a node clears the vector
 * floor without sitting close enough to another for near-duplicate suppression to fold them.
 */
function unit(axis: number, shared = 0.7): Vector {
  const raw = new Array<number>(EMBED_DIMENSION).fill(0.001);
  raw[0] = shared;
  raw[axis] = 0.7;
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

const CUE_VECTOR = unit(0, 0.99);
/** Off the shared axis entirely, so a node carrying it never reaches the pack on its own. */
const OFF_TOPIC = unit(7, 0.001);
/** Near the turn and away from the cue: the annotation is the only way into the pack. */
const BESIDE_THE_TURN = unit(5, 0.001);

/** The query text as the cue model would hand it back: one query cue, the caller's own words. */
function queryOf(request: StructuredRequest): string {
  const user = request.messages.find((message) => message.role === 'user');
  const match = /Query:\n(.*)/.exec(user?.content ?? '');
  return match?.[1]?.trim() ?? '';
}

/**
 * Each pushed observation opens with its own marker and gets its own axis. The near-duplicate cap
 * keys on the first sixteen characters and on the cosine between content vectors, so observations
 * that opened alike or embedded alike would be one cluster and the cap would drop all but two.
 */
const MARKER_AXES: Readonly<Record<string, number>> = {
  epsilonward: 2,
  zetaward: 3,
  etaward: 4,
  thetaward: 6,
  iotaward: 1,
};

function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  for (const [marker, axis] of Object.entries(MARKER_AXES)) {
    if (lowered.includes(marker)) {
      return unit(axis);
    }
  }
  return CUE_VECTOR;
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

function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, vectorLimit: 20, tokenBudget: 6000 },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sideEffects: RecallSideEffects;
let deps: RecallDeps;

type StatedReferences = {
  readonly supersedes?: readonly string[];
  readonly confirmations?: readonly {
    readonly target: string;
    readonly by: string;
    readonly evidence: string;
  }[];
};

async function push(
  observation: string,
  identity: string,
  provenance?: StatedReferences,
): Promise<string> {
  const result = await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions: deps.sessions,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
      publications: directIntakePublisher(harness.driver, db),
    },
    { observations: [observation], ...(provenance === undefined ? {} : { provenance }) },
    { identity, now: SEEDED_AT },
  );
  // Intake queues the embedding rather than performing it, so the fixture runs the row the
  // worker would run: what this file asserts on is vector search, which needs the vectors.
  await drainAcceptedVectors(harness.driver, provider);
  return result.episode_id;
}

/** The same query with both serving-layer subtractions off, so retrieval alone answers. */
async function unfilteredRecall(identity: string) {
  return handleRecall(
    {
      ...deps,
      config: {
        ...deps.config,
        recall: { ...deps.config.recall, ownSessionFilter: false, sessionDedup: false },
      },
    },
    { query: QUERY },
    { identity, now: RECALLED_AT },
  );
}

async function indexed(id: string): Promise<void> {
  await waitFor(`the vector index to cover ${id}`, async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: CUE_VECTOR,
      limit: 80,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === id);
  });
}

async function writeEpisode(id: string, text: string, vector: Vector): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: { text, session_id: `${id}-session`, content_vec: [...vector] },
  });
}

async function writeClaim(id: string, text: string, vector: Vector): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: {
      text,
      [TEXT_NORM_PROPERTY]: normalizeCognitiveText(text),
      content_vec: [...vector],
    },
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: id,
    targetId: CLAIM_EPISODE_ID,
    strength: 1,
    confidence: 1,
    signals: ['provenance'],
    provenance: ['test-fixture'],
    count: 0,
    now: SEEDED_AT,
  });
}

async function recall(identity: string) {
  return handleRecall(deps, { query: QUERY }, { identity, now: RECALLED_AT });
}

function turnOf(pack: Awaited<ReturnType<typeof recall>>) {
  return pack.episodes?.find((entry) => entry.id === TURN_ID);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-session-evidence-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  sideEffects = new RecallSideEffects(harness.driver, db, logger);
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
    onRecalled: sideEffects.onRecalled,
  };

  await writeEpisode(TURN_EPISODE_ID, 'an unrelated capture', OFF_TOPIC);
  await writeEpisode(CLAIM_EPISODE_ID, 'a separate look at the drain path', OFF_TOPIC);

  await writeStampedNode(harness.driver, {
    label: 'Turn',
    id: TURN_ID,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: {
      text: TURN_TEXT,
      role: 'user',
      sequence: 1,
      session_id: `${TURN_EPISODE_ID}-session`,
      source_episode_id: TURN_EPISODE_ID,
      extraction_method: 'reflection_intake',
      content_vec: [...unit(5)],
    },
  });

  // The turn's subject family: an entity whose stored name sits inside the turn's own fold, and a
  // current claim about it extracted somewhere else. Nothing distils a turn into a claim, so this
  // is the only thing that can stand beside the belief the turn states.
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id: SUBJECT_ID,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: {
      name: SUBJECT_NAME,
      name_norm: SUBJECT_NAME,
      type: 'concept',
      text: `${SUBJECT_NAME} (concept): the path uploads take into storage`,
      content_vec: [...OFF_TOPIC],
    },
  });
  await writeClaim(FAMILY_CLAIM_ID, FAMILY_CLAIM_TEXT, BESIDE_THE_TURN);

  await waitFor('the vector index to cover the turn', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: CUE_VECTOR,
      limit: 40,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === TURN_ID);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a related claim that changes after the turn was served', () => {
  it('delivers the new annotation, then suppresses the turn once nothing has moved', async () => {
    const identity = 'evidence-related-change';
    const first = await recall(identity);
    expect(turnOf(first)?.related_claim?.id).toBe(FAMILY_CLAIM_ID);

    await writeClaim(REPLACEMENT_CLAIM_ID, REPLACEMENT_CLAIM_TEXT, BESIDE_THE_TURN);
    await supersede(harness.driver, {
      oldId: FAMILY_CLAIM_ID,
      newId: REPLACEMENT_CLAIM_ID,
      now: SUPERSEDED_AT,
    });

    // A reader with no history gets the replacement, and it is absent from the facts bucket, so
    // the annotation under the turn is the only route it has into any pack.
    const controlled = await recall('evidence-related-control');
    expect(turnOf(controlled)?.related_claim?.id).toBe(REPLACEMENT_CLAIM_ID);
    expect(controlled.facts?.some((entry) => entry.id === REPLACEMENT_CLAIM_ID) ?? false).toBe(
      false,
    );

    const second = await recall(identity);
    expect(turnOf(second)?.related_claim?.id).toBe(REPLACEMENT_CLAIM_ID);

    // Nothing moved between the second recall and the third, so the session already holds it.
    const third = await recall(identity);
    expect(turnOf(third)).toBeUndefined();
    expect(third.metadata.suppressed_repeats ?? 0).toBeGreaterThan(0);
  });
});

/**
 * A memory the session itself wrote, that somebody else has since put evidence beside. The
 * conversation holds every word of its own observation and none of the evidence, and an origin
 * subtraction that reads only where a memory came from withholds both.
 */
describe('own-session memories after new external evidence', () => {
  const CONFIRMER = 'Ryan Huber';

  it('serves an own episode once another session states a correction', async () => {
    const identity = 'evidence-own-correction';
    const id = await push('epsilonward a unique queue drain observation', identity);
    await indexed(id);

    const before = await recall(identity);
    expect(before.episodes?.some((entry) => entry.id === id) ?? false).toBe(false);

    await push('zetaward an external correction of that observation', 'evidence-other-correction', {
      supersedes: [id],
    });

    // Retrieval and the graph attachment both work, so the origin subtraction is the only thing
    // that can be removing the episode from the reader's own pack.
    const controlled = await unfilteredRecall(identity);
    expect(controlled.episodes?.find((entry) => entry.id === id)?.claimed_correction).toBeDefined();

    const after = await recall(identity);
    expect(after.episodes?.find((entry) => entry.id === id)?.claimed_correction).toBeDefined();
    await sideEffects.whenIdle();
    const exposed = await accessMetadata(harness.driver, id);

    // Nothing moved after that delivery, so the fingerprint holds it and the session is charged
    // nothing further for a memory it was not handed again.
    const again = await recall(identity);
    expect(again.episodes?.some((entry) => entry.id === id) ?? false).toBe(false);
    await sideEffects.whenIdle();
    expect((await accessMetadata(harness.driver, id)).accessCount).toBe(exposed.accessCount);
  });

  it('serves an own episode once another session confirms it', async () => {
    const identity = 'evidence-own-confirmation';
    const id = await push('etaward a unique queue observation for confirmation', identity);
    await indexed(id);

    const before = await recall(identity);
    expect(before.episodes?.some((entry) => entry.id === id) ?? false).toBe(false);

    await push('thetaward an external confirmation', 'evidence-other-confirmation', {
      confirmations: [{ target: id, by: CONFIRMER, evidence: 'external review 555' }],
    });

    const controlled = await unfilteredRecall(identity);
    expect(
      controlled.episodes?.find((entry) => entry.id === id)?.standing?.confirmed,
    ).toBeDefined();

    const after = await recall(identity);
    expect(after.episodes?.find((entry) => entry.id === id)?.standing?.confirmed).toBeDefined();

    const again = await recall(identity);
    expect(again.episodes?.some((entry) => entry.id === id) ?? false).toBe(false);
  });

  /**
   * The read that says whether anybody put evidence beside a memory is the same read that can
   * fail. A larger pack during that failure is the cheaper mistake, since the alternative asserts
   * the session already knows what nothing could answer for.
   */
  it('serves an own episode when the provenance read answers for nothing', async () => {
    const identity = 'evidence-own-outage';
    const id = await push('iotaward an observation nobody else has touched', identity);
    await indexed(id);

    const before = await recall(identity);
    expect(before.episodes?.some((entry) => entry.id === id) ?? false).toBe(false);

    const spy = vi
      .spyOn(provenanceQueries, 'fetchClaimProvenance')
      .mockRejectedValueOnce(new Error('injected temporary graph error'));
    try {
      const during = await recall(identity);
      expect(during.episodes?.some((entry) => entry.id === id) ?? false).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
