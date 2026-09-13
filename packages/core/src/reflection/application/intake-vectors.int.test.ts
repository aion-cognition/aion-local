import neo4j, { type Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReflectionNotStoredError } from './errors.js';
import { VECTOR_JOB_TYPE } from './intake-queue.js';
import { handleReflection, INTEGRATE_JOB_TYPE, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { attachSourceVectors, findPendingVectorNodes } from './vectors.js';
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
import { directIntakePublisher } from '../test-support/direct-intake.fixture.js';

/**
 * Intake returns on durable publication and embeds nothing. The vector work is a queue row like
 * every other piece of background work, so an embedding service that is slow, wedged or down
 * costs the caller nothing: the episode is stored, the row is claimable, and recall serves the
 * episode through its lexical and recency paths until the row runs.
 *
 * Intake holds no embedder at all, which is the structural half. The behavioral half is here:
 * a returned call leaves every node of the acceptance bare, with a claimable row naming it.
 */
const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const DEAD_BOLT_URI = 'bolt://127.0.0.1:1';
const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const STORED_IDENTITY = 'vectors-stored-session';
const REFUSED_IDENTITY = 'vectors-refused-session';

const PAYLOAD = {
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
let enqueuedJobIds: string[];
let intake: ReflectionIntakeDeps;
let deadNeo4j: ReflectionIntakeDeps;
let embedder: OllamaProvider;
let storedEpisodeId: string;

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

  enqueuedJobIds = [];
  embedder = new OllamaProvider({ baseUrl: OLLAMA_URL, embedModel: DEFAULTS.models.embed });

  intake = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, backboneIds),
    onJobEnqueued: (jobId: string) => {
      enqueuedJobIds.push(jobId);
    },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications: directIntakePublisher(harness.driver, db),
  };

  deadGraph = neo4j.driver(DEAD_BOLT_URI, neo4j.auth.basic('neo4j', harness.password), {
    connectionTimeout: 2000,
    connectionAcquisitionTimeout: 3000,
    maxTransactionRetryTime: 3000,
  });
  deadNeo4j = {
    ...intake,
    driver: deadGraph,
    sessions: new SessionManager(deadGraph, backboneIds),
  };

  storedEpisodeId = (await handleReflection(intake, PAYLOAD, { identity: STORED_IDENTITY }))
    .episode_id;
}, 300_000);

afterAll(async () => {
  await deadGraph.close();
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('what intake does about vectors', () => {
  it('returns with every node of the acceptance still bare', async () => {
    const result = await handleReflection(
      intake,
      { ...PAYLOAD, observations: ['a second experience in the same session'] },
      { identity: STORED_IDENTITY },
    );

    // Read the instant the call resolves: an intake that embedded would have written these.
    const turns = await turnsOfEpisode(harness.driver, result.episode_id);
    expect(await contentVectorOf(result.episode_id)).toBeUndefined();
    expect(turns.every((turn) => turn.content_vec === undefined)).toBe(true);
  });

  it('stores the episode, its turns, and the whole backbone', async () => {
    const props = await nodeProperties(harness.driver, storedEpisodeId);

    expect(props.summary).toBe(PAYLOAD.summary);
    expect(props.extraction_method).toBe('reflection_intake');
    expect(props.valid_from).toBeInstanceOf(Date);
    expect(props.tx_from).toBeInstanceOf(Date);

    expect(await countChainedTurns(harness.driver, storedEpisodeId)).toBe(1);
    expect(await edgeTargetId(harness.driver, 'PARTICIPATES_IN', storedEpisodeId)).toBe(
      STORED_IDENTITY,
    );
    expect(
      await countEdges(harness.driver, 'PARTICIPATES_IN', storedEpisodeId, STORED_IDENTITY),
    ).toBe(1);
  });

  it('queues the vector job beside the integrate job, in the same lane', async () => {
    const jobs = (await jobsForSession(STORED_IDENTITY)).filter(
      (job) => (job.payload as { episode_id: string }).episode_id === storedEpisodeId,
    );
    const byType = new Map(jobs.map((job) => [job.jobType, job]));

    expect([...byType.keys()].sort()).toEqual(
      [INTEGRATE_JOB_TYPE, VECTOR_JOB_TYPE, 'source_index'].sort(),
    );
    expect(byType.get(VECTOR_JOB_TYPE)?.lane).toBe('interactive');
    expect(byType.get(VECTOR_JOB_TYPE)?.payload).toEqual({ episode_id: storedEpisodeId });
    expect(byType.get(VECTOR_JOB_TYPE)?.episodeId).toBe(storedEpisodeId);
  });

  it('leaves the episode and every turn without a content vector until that row runs', async () => {
    const turns = await turnsOfEpisode(harness.driver, storedEpisodeId);

    expect(await contentVectorOf(storedEpisodeId)).toBeUndefined();
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.content_vec === undefined)).toBe(true);
  });
});

describe('the queued vector work', () => {
  it('vectors exactly the source it names, and nothing else pending', async () => {
    const others = (await findPendingVectorNodes(harness.driver, 50))
      .map((node) => node.id)
      .filter((id) => id !== storedEpisodeId);
    const turns = await turnsOfEpisode(harness.driver, storedEpisodeId);
    const mine = new Set([storedEpisodeId, ...turns.map((turn) => turn.id as string)]);

    const attached = await attachSourceVectors(
      { driver: harness.driver, provider: embedder, logger: { warn: () => undefined } },
      storedEpisodeId,
    );

    expect(attached).toBe(mine.size);
    for (const id of mine) {
      const vector = await contentVectorOf(id);
      expect(vector).toHaveLength(EMBED_DIMENSION);
      expect(vector?.every((value) => Number.isFinite(value))).toBe(true);
    }
    // Another source's pending nodes are somebody else's row and are still pending.
    const stillPending = (await findPendingVectorNodes(harness.driver, 50)).map((node) => node.id);
    expect(stillPending.sort()).toEqual(others.filter((id) => !mine.has(id)).sort());
  }, 120_000);

  it('is idempotent: a second run finds nothing left to do for that source', async () => {
    const before = await contentVectorOf(storedEpisodeId);

    const again = await attachSourceVectors(
      { driver: harness.driver, provider: embedder, logger: { warn: () => undefined } },
      storedEpisodeId,
    );

    expect(again).toBe(0);
    expect(await contentVectorOf(storedEpisodeId)).toEqual(before);
  }, 120_000);
});

/**
 * The other half of the inversion: an unreachable graph has nowhere to put the experience,
 * so it still refuses by name. Telling the caller "queued" here would lose the reflection
 * for good, since nothing would ever be there to retry from.
 */
describe('reflection intake against an unreachable graph', () => {
  it('refuses with the named error and writes nothing', async () => {
    const wakeupsBeforeRefusal = enqueuedJobIds.length;
    const failure = await handleReflection(deadNeo4j, PAYLOAD, {
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
    // No job, so no wakeup: the refusal costs the worker nothing to claim.
    expect(enqueuedJobIds).toHaveLength(wakeupsBeforeRefusal);
  });
});
