import neo4j, { type Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReflectionDispatch, type ReflectionJobSignal } from './dispatch.js';
import { ReflectionNotStoredError } from './errors.js';
import { handleReflection, INTEGRATE_JOB_TYPE, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { attachContentVectors, findPendingVectorNodes } from './vectors.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  countChainedTurns,
  countEdges,
  countNodesInSession,
  edgeTargetId,
  episodeIdsInSession,
  nodeProperties,
  turnsOfEpisode,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listReflectionJobs,
  type ReflectionJob,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The episode commits before anything embeds, so a reflection pushed through a total
 * inference outage is still stored and queued, with its vectors arriving later. The outage
 * here is real: an Ollama pointed at the discard port, not a stubbed rejection, because the
 * guarantee is about what the write path does when the network call actually fails.
 */
const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const DEAD_OLLAMA_URL = 'http://127.0.0.1:9';
const DEAD_BOLT_URI = 'bolt://127.0.0.1:1';

const VECTORED_IDENTITY = 'vectors-live-session';
const PENDING_IDENTITY = 'vectors-pending-session';
const REFUSED_IDENTITY = 'vectors-refused-session';

const LIVE_PAYLOAD = {
  turns: [
    { role: 'user', text: 'the ingestion service keeps timing out on the vendor webhook' },
    { role: 'assistant', text: 'the vendor caps concurrent deliveries at four' },
  ],
  observations: ['the timeout is the vendor cap, not our handler'],
  summary: 'ingestion webhook timeouts traced to a vendor concurrency cap',
};

const OUTAGE_PAYLOAD = {
  turns: [
    { role: 'user', text: 'why did we key the physician sync on id_slug' },
    { role: 'assistant', text: 'because the external ids churn between vendor exports' },
  ],
  observations: ['id_slug is stable across exports, the external id is not'],
  summary: 'physician sync keyed on id_slug',
};

let harness: Neo4jHarness;
let deadGraph: Driver;
let db: SqliteHandle;
let dataDir: string;
let signals: ReflectionJobSignal[];
let live: ReflectionIntakeDeps;
let deadOllama: ReflectionIntakeDeps;
let deadNeo4j: ReflectionIntakeDeps;
let vectoredEpisodeId: string;
let pendingEpisodeId: string;

async function jobsForSession(sessionId: string): Promise<ReflectionJob[]> {
  const episodeIds = new Set(await episodeIdsInSession(harness.driver, sessionId));
  return listReflectionJobs(db).filter((job) =>
    episodeIds.has((job.payload as { episode_id: string }).episode_id),
  );
}

async function contentVectorOf(id: string): Promise<number[] | undefined> {
  const value = (await nodeProperties(harness.driver, id)).content_vec;
  return Array.isArray(value) ? (value as number[]) : undefined;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-intake-vectors-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  const backboneIds = { memberId: backbone.member.id, workspaceId: backbone.workspace.id };

  signals = [];
  const dispatch = new ReflectionDispatch();
  dispatch.subscribe((signal) => {
    signals.push(signal);
  });

  const shared = {
    db,
    dispatch,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };

  live = {
    ...shared,
    driver: harness.driver,
    sessions: new SessionManager(harness.driver, backboneIds),
    provider: new OllamaProvider({
      baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      embedModel: DEFAULTS.models.embed,
    }),
  };

  deadOllama = {
    ...live,
    provider: new OllamaProvider({ baseUrl: DEAD_OLLAMA_URL, embedModel: DEFAULTS.models.embed }),
  };

  deadGraph = neo4j.driver(DEAD_BOLT_URI, neo4j.auth.basic('neo4j', harness.password), {
    connectionTimeout: 2000,
    connectionAcquisitionTimeout: 3000,
    maxTransactionRetryTime: 3000,
  });
  deadNeo4j = {
    ...deadOllama,
    driver: deadGraph,
    sessions: new SessionManager(deadGraph, backboneIds),
  };

  vectoredEpisodeId = (await handleReflection(live, LIVE_PAYLOAD, { identity: VECTORED_IDENTITY }))
    .episode_id;
  pendingEpisodeId = (
    await handleReflection(deadOllama, OUTAGE_PAYLOAD, { identity: PENDING_IDENTITY })
  ).episode_id;
}, 300_000);

afterAll(async () => {
  await deadGraph.close();
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reflection intake through a total Ollama outage', () => {
  it('answers the caller normally rather than refusing', () => {
    expect(pendingEpisodeId).toEqual(expect.any(String));
    expect(pendingEpisodeId).not.toBe(vectoredEpisodeId);
  });

  it('stores the episode, its turns, and the whole backbone', async () => {
    const props = await nodeProperties(harness.driver, pendingEpisodeId);

    expect(props.summary).toBe(OUTAGE_PAYLOAD.summary);
    expect(props.extraction_method).toBe('reflection_intake');
    expect(props.valid_from).toBeInstanceOf(Date);
    expect(props.tx_from).toBeInstanceOf(Date);

    expect(await countNodesInSession(harness.driver, 'Turn', PENDING_IDENTITY)).toBe(2);
    expect(await countChainedTurns(harness.driver, pendingEpisodeId)).toBe(1);
    expect(await edgeTargetId(harness.driver, 'PARTICIPATES_IN', pendingEpisodeId)).toBe(
      PENDING_IDENTITY,
    );
    expect(
      await countEdges(harness.driver, 'PARTICIPATES_IN', pendingEpisodeId, PENDING_IDENTITY),
    ).toBe(1);
  });

  it('queues the integrate job and signals the dispatcher', async () => {
    const jobs = await jobsForSession(PENDING_IDENTITY);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe(INTEGRATE_JOB_TYPE);
    expect(signals.map((signal) => signal.episodeId)).toContain(pendingEpisodeId);
  });

  it('leaves the episode and every turn without a content vector', async () => {
    const turns = await turnsOfEpisode(harness.driver, pendingEpisodeId);

    expect(await contentVectorOf(pendingEpisodeId)).toBeUndefined();
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.content_vec === undefined)).toBe(true);
  });
});

describe('backfilling the pending vectors once Ollama is back', () => {
  it('finds exactly the nodes the outage left pending', async () => {
    const pending = await findPendingVectorNodes(harness.driver, 50);
    const turns = await turnsOfEpisode(harness.driver, pendingEpisodeId);

    expect(pending.map((node) => node.id).sort()).toEqual(
      [pendingEpisodeId, ...turns.map((turn) => turn.id as string)].sort(),
    );
    expect(pending.every((node) => node.text.length > 0)).toBe(true);
  });

  it('attaches a vector of the configured dimension to every one of them', async () => {
    const pending = await findPendingVectorNodes(harness.driver, 50);

    const attached = await attachContentVectors(harness.driver, live.provider, pending);

    expect(attached.sort()).toEqual(pending.map((node) => node.id).sort());
    for (const node of pending) {
      const vector = await contentVectorOf(node.id);
      expect(vector).toHaveLength(EMBED_DIMENSION);
      expect(vector?.every((value) => Number.isFinite(value))).toBe(true);
    }
    expect(await findPendingVectorNodes(harness.driver, 50)).toEqual([]);
  });

  it('is idempotent: a second pass writes the same vectors and finds nothing left', async () => {
    const before = await contentVectorOf(pendingEpisodeId);

    const again = await attachContentVectors(harness.driver, live.provider, [
      {
        id: pendingEpisodeId,
        text: (await nodeProperties(harness.driver, pendingEpisodeId)).text as string,
      },
    ]);

    expect(again).toEqual([pendingEpisodeId]);
    expect(await contentVectorOf(pendingEpisodeId)).toEqual(before);
    expect(await findPendingVectorNodes(harness.driver, 50)).toEqual([]);
  });

  it('never touches a node that already had its vector', async () => {
    expect(await contentVectorOf(vectoredEpisodeId)).toHaveLength(EMBED_DIMENSION);
    expect(await attachContentVectors(harness.driver, live.provider, [])).toEqual([]);
  });
});

/**
 * The other half of the inversion: an unreachable graph has nowhere to put the experience,
 * so it still refuses by name. Telling the caller "queued" here would lose the reflection
 * for good, since nothing would ever be there to retry from.
 */
describe('reflection intake against an unreachable graph', () => {
  it('refuses with the named error and writes nothing', async () => {
    const failure = await handleReflection(deadNeo4j, OUTAGE_PAYLOAD, {
      identity: REFUSED_IDENTITY,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(ReflectionNotStoredError);
    expect((failure as ReflectionNotStoredError).stage).toBe('graph');
    expect((failure as Error).message).toContain('nothing was queued');

    expect(await countNodesInSession(harness.driver, 'Episode', REFUSED_IDENTITY)).toBe(0);
    expect(await countNodesInSession(harness.driver, 'Turn', REFUSED_IDENTITY)).toBe(0);
    expect(await jobsForSession(REFUSED_IDENTITY)).toHaveLength(0);
    expect(signals.map((signal) => signal.sessionId)).not.toContain(REFUSED_IDENTITY);
  });
});
