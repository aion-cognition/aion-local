import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleReflection, INTEGRATE_JOB_TYPE, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  countChainedTurns,
  countEdges,
  countNodes,
  countNodesInSession,
  countRelationships,
  edgeTargetId,
  episodeIdsInSession,
  everyStoredProperty,
  nodeLabels,
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
  ARCHIVE_SCHEMA_VERSION,
  getExperienceByEpisode,
} from '../../infrastructure/sqlite/experience-archive.js';
import {
  listReflectionJobs,
  type ReflectionJob,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { SessionManager } from '../../session/session-manager.js';
import { PIPELINE_VERSION } from '../domain/version.js';

const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const SESSION_IDENTITY = 'mcp-transport-session-1';

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GITHUB_TOKEN = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const SLACK_TOKEN = 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx';

const MIXED_PAYLOAD = {
  turns: [
    {
      role: 'user',
      text: `deploy the ingestion service, the runner key is ${AWS_KEY}`,
      occurred_at: '2026-03-01T10:00:00Z',
    },
    { role: 'assistant', text: 'running the deploy now', occurred_at: '2026-03-01T10:00:05Z' },
  ],
  tool_executions: [
    {
      tool: 'bash',
      input: 'npm run deploy',
      status: 'error',
      // The slack token sits in key position: a credential arrives as a map key whenever
      // tool output is keyed by it, and the walk has to reach that too.
      output: { stderr: `remote auth failed for ${GITHUB_TOKEN}`, [SLACK_TOKEN]: 'revoked' },
      duration_ms: 8200,
      occurred_at: '2026-03-01T10:00:02Z',
    },
  ],
  observations: ['We keyed the sync on id_slug because the external ids churn'],
  summary: 'failed deploy of the ingestion service',
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let deps: ReflectionIntakeDeps;
let enqueuedJobIds: string[];
let backboneIds: { memberId: string; workspaceId: string };
let episodeId: string;

function ledgerRowCount(): number {
  return (db.prepare('SELECT count(*) AS c FROM ops_ledger').get() as { c: number }).c;
}

/** Queue rows whose episode belongs to this session, matched through the graph. */
async function jobsForSession(sessionId: string): Promise<ReflectionJob[]> {
  const episodeIds = new Set(await episodeIdsInSession(harness.driver, sessionId));
  return listReflectionJobs(db).filter((job) =>
    episodeIds.has((job.payload as { episode_id: string }).episode_id),
  );
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-reflection-intake-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  backboneIds = { memberId: backbone.member.id, workspaceId: backbone.workspace.id };

  enqueuedJobIds = [];

  deps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, backboneIds),
    provider: new OllamaProvider({
      baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      embedModel: DEFAULTS.models.embed,
    }),
    onJobEnqueued: (jobId: string) => {
      enqueuedJobIds.push(jobId);
    },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };

  const result = await handleReflection(deps, MIXED_PAYLOAD, { identity: SESSION_IDENTITY });
  expect(result.queued).toBe(true);
  episodeId = result.episode_id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reflection intake against a live graph and live Ollama', () => {
  it('stores the episode with its labels, content, provenance, and a full bitemporal stamp', async () => {
    const props = await nodeProperties(harness.driver, episodeId);

    expect(await nodeLabels(harness.driver, episodeId)).toEqual(['AionNode', 'Episode', 'Memory']);
    expect(props.summary).toBe(MIXED_PAYLOAD.summary);
    expect(props.session_id).toBe(SESSION_IDENTITY);
    expect(props.extraction_method).toBe('reflection_intake');
    expect(props.turn_count).toBe(2);
    expect(props.tool_execution_count).toBe(1);
    expect(props.observation_count).toBeUndefined();
    expect(props.content_hash).toEqual(expect.any(String));

    expect(props.occurred_at).toBeInstanceOf(Date);
    expect((props.occurred_at as Date).toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(props.valid_from).toBeInstanceOf(Date);
    expect(props.tx_from).toBeInstanceOf(Date);
    expect(props.valid_until).toBeUndefined();
    expect(props.tx_until).toBeUndefined();
  });

  it('folds tool executions and observations into the episode body', async () => {
    const text = (await nodeProperties(harness.driver, episodeId)).text as string;

    expect(text).toContain('tool bash [error, 8200ms]');
    expect(text).toContain('observation: We keyed the sync on id_slug');
    expect(text).toContain('user: deploy the ingestion service');
  });

  it('stores every turn in order, linked to the episode and chained to its predecessor', async () => {
    const turns = await turnsOfEpisode(harness.driver, episodeId);

    expect(turns.map((turn) => turn.sequence)).toEqual([0, 1]);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns.every((turn) => turn.source_episode_id === episodeId)).toBe(true);
    expect(turns.every((turn) => turn.occurred_at instanceof Date)).toBe(true);
    expect(turns.every((turn) => turn.valid_until === undefined)).toBe(true);

    expect(await countChainedTurns(harness.driver, episodeId)).toBe(1);
  });

  it('links the episode into the session and the session into the backbone', async () => {
    expect(await edgeTargetId(harness.driver, 'PARTICIPATES_IN', episodeId)).toBe(SESSION_IDENTITY);
    expect(await edgeTargetId(harness.driver, 'INITIATED_BY', SESSION_IDENTITY)).toBe(
      backboneIds.memberId,
    );
    expect(await edgeTargetId(harness.driver, 'WITHIN_WORKSPACE', SESSION_IDENTITY)).toBe(
      backboneIds.workspaceId,
    );
  });

  it('attaches a vector to the episode and every turn after the commit, at the configured dimension', async () => {
    const episodeVector = (await nodeProperties(harness.driver, episodeId)).content_vec as number[];
    const turns = await turnsOfEpisode(harness.driver, episodeId);

    expect(episodeVector).toHaveLength(EMBED_DIMENSION);
    expect(episodeVector.every((value) => Number.isFinite(value))).toBe(true);
    for (const turn of turns) {
      expect(turn.content_vec as number[]).toHaveLength(EMBED_DIMENSION);
    }
  });

  it('enqueues one integrate job carrying the episode id, and wakes the worker once', () => {
    const jobs = listReflectionJobs(db);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe(INTEGRATE_JOB_TYPE);
    expect(jobs[0]?.payload).toEqual({ episode_id: episodeId });
    expect(jobs[0]?.claimedBy).toBeNull();

    expect(enqueuedJobIds).toEqual([jobs[0]?.id]);
  });

  it('leaves the ops ledger untouched: the pipeline owns it, not intake', () => {
    expect(ledgerRowCount()).toBe(0);
  });

  it('archives the redacted payload beside the episode, stamped at the payload clock', async () => {
    const row = getExperienceByEpisode(db, episodeId);
    const props = await nodeProperties(harness.driver, episodeId);

    expect(row).toMatchObject({
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      identity: SESSION_IDENTITY,
      sessionId: SESSION_IDENTITY,
      episodeId,
      contentHash: props.content_hash as string,
      occurredAt: (props.occurred_at as Date).toISOString(),
    });
    // The archive moment is the wall clock, which is months after this payload happened.
    expect(Date.parse(row?.archivedAt ?? '')).toBeGreaterThan(Date.parse(row?.occurredAt ?? ''));

    const archived = JSON.stringify(row?.payload);
    expect(archived).not.toContain(AWS_KEY);
    expect(archived).not.toContain(GITHUB_TOKEN);
    expect(archived).not.toContain(SLACK_TOKEN);
    expect(archived).toContain('⟨secret:aws-access-key:');
    expect(archived).toContain('⟨secret:slack-token:');
  });

  it('writes no origin property at all when the caller names none', async () => {
    const props = await nodeProperties(harness.driver, episodeId);

    expect(props.origin_channel).toBeUndefined();
    expect(props.origin_event).toBeUndefined();
  });

  it('never stores the raw secret in any node property, only its fingerprint', async () => {
    const stored = await everyStoredProperty(harness.driver);

    expect(stored).not.toContain(AWS_KEY);
    expect(stored).not.toContain(GITHUB_TOKEN);
    expect(stored).not.toContain(SLACK_TOKEN);
    expect(stored).toContain('⟨secret:aws-access-key:');
    expect(stored).toContain('⟨secret:github-token:');
    expect(stored).toContain('⟨secret:slack-token:');
  });

  it('returns the original episode id for a repeat push, writing no new nodes, edges, or jobs', async () => {
    const nodesBefore = await countNodes(harness.driver);
    const edgesBefore = await countRelationships(harness.driver);

    const repeat = await handleReflection(deps, MIXED_PAYLOAD, { identity: SESSION_IDENTITY });

    // The only queued interactive job is the row this push matched, which is this caller's own,
    // so nothing sits ahead of it.
    expect(repeat).toEqual({
      episode_id: episodeId,
      queued: true,
      lane: 'interactive',
      pending_ahead: 0,
    });
    expect(await countNodes(harness.driver)).toBe(nodesBefore);
    expect(await countRelationships(harness.driver)).toBe(edgesBefore);
    expect(listReflectionJobs(db)).toHaveLength(1);
    expect(enqueuedJobIds).toHaveLength(1);
    expect(ledgerRowCount()).toBe(0);
  });

  it('stores the same experience again under a second session identity', async () => {
    const other = await handleReflection(deps, MIXED_PAYLOAD, {
      identity: 'mcp-transport-session-2',
    });

    expect(other.episode_id).not.toBe(episodeId);
    expect(listReflectionJobs(db)).toHaveLength(2);
    expect(enqueuedJobIds).toHaveLength(2);

    expect(
      await countEdges(harness.driver, 'FOLLOWS', 'mcp-transport-session-2', SESSION_IDENTITY),
    ).toBe(1);
  });

  it('stores the origin channel and event when the caller names one', async () => {
    const result = await handleReflection(
      deps,
      { ...MIXED_PAYLOAD, origin: { channel: 'hook', event: 'session-end' } },
      { identity: 'origin-session' },
    );

    const props = await nodeProperties(harness.driver, result.episode_id);
    expect(props.origin_channel).toBe('hook');
    expect(props.origin_event).toBe('session-end');
  });
});

/**
 * The real driver with a fuse in its write transactions: statement `allowed + 1` onward
 * rejects. Atomicity is a property of the transaction, so proving it needs a failure that
 * lands inside one, and after store-before-embed no dependency of intake can produce one.
 */
function driverFailingAfter(driver: Driver, allowed: number): Driver {
  const executeQuery = driver.executeQuery.bind(driver);
  return {
    executeQuery,
    session: () => {
      const session = driver.session();
      return {
        executeWrite: (work: (tx: unknown) => Promise<unknown>) =>
          session.executeWrite((tx) => {
            let seen = 0;
            return work({
              run: async (cypher: string, parameters: Record<string, unknown>) => {
                seen += 1;
                if (seen > allowed) {
                  throw new Error('severed mid-transaction');
                }
                return tx.run(cypher, parameters);
              },
            });
          }),
        close: () => session.close(),
      };
    },
  } as unknown as Driver;
}

describe('reflection intake under failure and concurrency', () => {
  const PAYLOAD = {
    turns: [
      { role: 'user', text: 'why did the ingestion service pick webhooks' },
      { role: 'assistant', text: 'because the vendor has no bulk export' },
    ],
    observations: ['webhooks were the only option with the vendor we had'],
  };

  it('writes nothing at all when a write fails partway through the episode', async () => {
    const identity = 'partial-write-session';

    // The lock, the dedupe read, the Episode node, its containment edge, and the first
    // Turn go through; the sixth statement throws. Nothing embedded can force this any
    // more, since the embed call now happens after the commit, so the failure is injected
    // at the statement the transaction is on when it lands.
    const severed = { ...deps, driver: driverFailingAfter(harness.driver, 5) };

    await expect(handleReflection(severed, PAYLOAD, { identity })).rejects.toThrow(/severed/);

    expect(await countNodesInSession(harness.driver, 'Episode', identity)).toBe(0);
    expect(await countNodesInSession(harness.driver, 'Turn', identity)).toBe(0);
    expect(await jobsForSession(identity)).toHaveLength(0);

    // A clean retry starts from nothing, so the episode lands whole.
    const retry = await handleReflection(deps, PAYLOAD, { identity });
    expect(await countNodesInSession(harness.driver, 'Episode', identity)).toBe(1);
    expect(await countNodesInSession(harness.driver, 'Turn', identity)).toBe(2);
    expect(await jobsForSession(identity)).toHaveLength(1);
    expect(retry.queued).toBe(true);
  });

  it('queues the job on retry when the episode committed but the enqueue did not', async () => {
    const identity = 'orphan-episode-session';

    // The graph write commits, then the queue insert fails: the window a crash between the
    // two stores opens. Nothing repairs it later, so intake has to repair it on the retry.
    const closed = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
    closed.close();

    await expect(
      handleReflection({ ...deps, db: closed }, PAYLOAD, { identity }),
    ).rejects.toThrow();

    expect(await countNodesInSession(harness.driver, 'Episode', identity)).toBe(1);
    expect(await jobsForSession(identity)).toHaveLength(0);

    const retry = await handleReflection(deps, PAYLOAD, { identity });
    const queued = await jobsForSession(identity);

    expect(await countNodesInSession(harness.driver, 'Episode', identity)).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({ episode_id: retry.episode_id });
    expect(retry.queued).toBe(true);
  });

  it('stores one episode when the same payload arrives concurrently in one session', async () => {
    const identity = 'concurrent-intake-session';

    // A stub embedder, not live Ollama: Ollama serializes requests for one model, which
    // staggers the callers enough that they never reach the graph together. The race this
    // test exists for is in the graph, and it only happens if they arrive at once.
    const vector = Array.from({ length: EMBED_DIMENSION }, () => 0.01);
    const instant = {
      ...deps,
      provider: {
        embed: (texts: readonly string[]) => Promise.resolve(texts.map(() => vector)),
        generate: () => Promise.reject(new Error('intake must never call generate')),
      } as ReflectionIntakeDeps['provider'],
    };

    const results = await Promise.all([
      handleReflection(instant, PAYLOAD, { identity }),
      handleReflection(instant, PAYLOAD, { identity }),
      handleReflection(instant, PAYLOAD, { identity }),
      handleReflection(instant, PAYLOAD, { identity }),
    ]);

    const ids = new Set(results.map((result) => result.episode_id));
    expect(ids.size).toBe(1);
    expect(await countNodesInSession(harness.driver, 'Episode', identity)).toBe(1);
    expect(await countNodesInSession(harness.driver, 'Turn', identity)).toBe(2);
    expect(await jobsForSession(identity)).toHaveLength(1);
  });
});
