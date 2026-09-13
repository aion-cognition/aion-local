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
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
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
import {
  directIntakePublisher,
  drainAcceptedVectors,
} from '../../reflection/test-support/direct-intake.fixture.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * R4's disclosed path-strength lane, against a live substrate: one episode reachable by graph
 * path alone. It carries no content vector, so no floor ever measures it and no exact match ever
 * finds it, which is exactly the population `droppedUnmeasuredArrival` counts and the lane
 * exists to disclose a few of. Written directly rather than through intake, so that no vector
 * job is ever queued for it; the point of the fixture is a node the embedding never reaches.
 */

const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';
const WRITE_SESSION = 'path-admission-session-write';
const READ_SESSION = 'path-admission-session-read';

const STARTED_AT = new Date('2026-06-01T09:00:00.000Z');
const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

const QUERY = 'why did we pick webhooks for ingestion';
const CUE = 'webhooks';

/** Names the subject, so this is the run's only seed at the shipped-narrow budget below. */
const ANCHOR_TEXT = 'we picked webhooks for the ingestion service because polling was too slow';

/** Shares no words with the cue and carries no content vector: unmeasured by construction. */
const PATH_ONLY_TEXT = 'the printer on the second floor jams every Tuesday afternoon';

function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

function vectorFor(text: string): Vector {
  return text.toLowerCase().includes('webhook') ? axis(0) : axis(1);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

/** One seed at this budget, same narrowing `activation-admission.int.test.ts` uses. */
function config(pathStrengthSlots: number): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: {
      ...DEFAULTS.recall,
      vectorLimit: 1,
      sessionDedup: false,
      ownSessionFilter: false,
      pathStrengthSlots,
    },
    contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 1 },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let baseDeps: RecallDeps;
let pathOnlyEpisodeId: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-path-admission-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  const sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  baseDeps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config: config(DEFAULTS.recall.pathStrengthSlots),
    cueCache: new CueCache(),
    logger,
  };

  // The anchor, through intake: it enters the fulltext index, and intake connects it to a real
  // Session node the normal way (PARTICIPATES_IN). Its embedding is a queue row, drained below.
  await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
      publications: directIntakePublisher(harness.driver, db),
    },
    { observations: [ANCHOR_TEXT] },
    { identity: WRITE_SESSION, now: STARTED_AT },
  );
  // The anchor's vectors, and only the anchor's: the path-only node below is written after this
  // and stays bare, which is the whole point of the fixture.
  await drainAcceptedVectors(harness.driver, provider);

  // The path-only episode, written directly: real text to render, no `content_vec` at all, so
  // arrival scoring has nothing to measure it against the query with. Wired into the same
  // session the anchor joined, one hop further out, so activation reaches it at anchor -[
  // PARTICIPATES_IN]-> session <-[PARTICIPATES_IN]- path-only.
  const sessionId = sessions.sessionIdFor(WRITE_SESSION);
  const node = await writeStampedNode(harness.driver, {
    label: 'Episode',
    now: new Date(STARTED_AT.getTime() + 60_000),
    occurredAt: new Date(STARTED_AT.getTime() + 60_000),
    properties: {
      [MEMORY_PROPERTIES.text]: PATH_ONLY_TEXT,
      [MEMORY_PROPERTIES.sessionId]: sessionId,
    },
  });
  pathOnlyEpisodeId = node.id;
  await upsertEdge(harness.driver, {
    type: CONTAINMENT_TYPE,
    sourceId: pathOnlyEpisodeId,
    targetId: sessionId,
    strength: 1,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test-fixture'],
    count: 1,
    now: new Date(STARTED_AT.getTime() + 60_000),
  });

  await waitFor('the vector index to cover the anchor episode', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: 10,
      mode: withCurrency(),
    });
    return rows.length >= 1;
  });

  await waitFor('the fulltext index to cover the anchor episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id !== pathOnlyEpisodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function recall(pathStrengthSlots: number): Promise<Awaited<ReturnType<typeof handleRecall>>> {
  const deps: RecallDeps = {
    ...baseDeps,
    config: config(pathStrengthSlots),
    cueCache: new CueCache(),
  };
  return handleRecall(deps, { query: QUERY }, { identity: READ_SESSION, now: RECALLED_AT });
}

describe('the disclosed path-strength lane against a live substrate', () => {
  it('is out of reach of every measured leg: no content vector, no shared words', async () => {
    const lexical = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    expect(lexical.map((row) => row.id)).not.toContain(pathOnlyEpisodeId);
  });

  it('lands in the pack through the lane, with its graph path in the rationale', async () => {
    const pack = await recall(2);

    const found = pack.episodes?.find((item) => item.id === pathOnlyEpisodeId);
    expect(found).toBeDefined();
    expect(found?.rationale.method).toBe('activation');
    expect(found?.rationale.path).toContain('PARTICIPATES_IN');
    expect(found?.admitted_by?.rule).toBe('path_strength');
    expect(pack.metadata.admission.dropped_unmeasured_arrival).toBeGreaterThan(0);
    expect(pack.metadata.admission.path_admitted).toBe(1);
  });

  it('is byte-identical to the floor-only gate when the knob is 0', async () => {
    const withLane = await recall(2);
    const withoutLane = await recall(0);

    expect(withoutLane.episodes?.map((item) => item.id)).not.toContain(pathOnlyEpisodeId);
    expect(withLane.episodes?.map((item) => item.id)).toContain(pathOnlyEpisodeId);
    // Removing the lane removes exactly its own admission: the anchor's own item, the admission
    // counts a floor would have produced, and the rest of the pack's shape are all untouched.
    const anchorWith = withLane.episodes?.find((item) => item.id !== pathOnlyEpisodeId);
    const anchorWithout = withoutLane.episodes?.find((item) => item.id !== pathOnlyEpisodeId);
    expect(anchorWithout).toEqual(anchorWith);
    expect(withoutLane.metadata.admission.path_admitted).toBe(0);
    expect(withoutLane.metadata.admission.dropped_unmeasured_arrival).toBe(
      withLane.metadata.admission.dropped_unmeasured_arrival,
    );
  });
});
