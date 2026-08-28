import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLogger } from '../logging/logger.js';
import type { Vector } from '../providers/types.js';
import { SessionManager } from '../session/session-manager.js';
import { ReflectionQueueClaimant } from '../sqlite/claim.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import { listReflectionJobs } from '../sqlite/reflection-queue.js';
import { ReflectionDispatch, type ReflectionJobSignal } from './dispatch.js';
import { handleReflection, INTEGRATE_JOB_TYPE, type ReflectionIntakeDeps } from './intake.js';
import { FakeGraph } from './test-support/fake-graph.fixture.js';

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-1';
const EMBED_DIMENSION = 8;

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GITHUB_TOKEN = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

const PAYLOAD = {
  turns: [
    { role: 'user', text: `deploy the ingestion service with ${AWS_KEY}` },
    { role: 'assistant', text: 'running the deploy now' },
  ],
  tool_executions: [
    {
      tool: 'bash',
      input: 'npm run deploy',
      status: 'error',
      output: { stderr: `auth failed for ${GITHUB_TOKEN}` },
      duration_ms: 8200,
    },
  ],
  observations: ['We keyed the sync on id_slug because the external ids churn'],
  summary: 'failed deploy of the ingestion service',
};

let graph: FakeGraph;
let db: SqliteHandle;
let dataDir: string;
let signals: ReflectionJobSignal[];
let embed: ReturnType<typeof vi.fn>;
let generate: ReturnType<typeof vi.fn>;
let deps: ReflectionIntakeDeps;

function fakeVectors(texts: readonly string[]): Vector[] {
  return texts.map((_, index) =>
    Array.from({ length: EMBED_DIMENSION }, (__, slot) => (index + 1) / (slot + 1)),
  );
}

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode']);
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode']);

  dataDir = mkdtempSync(join(tmpdir(), 'aion-reflection-intake-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });

  signals = [];
  const dispatch = new ReflectionDispatch();
  dispatch.subscribe((signal) => {
    signals.push(signal);
  });

  embed = vi.fn((texts: readonly string[]) => Promise.resolve(fakeVectors(texts)));
  generate = vi.fn(() => Promise.reject(new Error('intake must never call generate')));

  deps = {
    driver: graph.driver,
    db,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    provider: { embed, generate } as unknown as ReflectionIntakeDeps['provider'],
    dispatch,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: 4.5,
  };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function embeddedTexts(call: number): string {
  return (embed.mock.calls[call]?.[0] as readonly string[]).join('\n');
}

describe('reflection intake validation', () => {
  it('rejects a payload carrying no experience, before it touches the graph or the queue', async () => {
    await expect(
      handleReflection(deps, { summary: 'nothing happened' }, { identity: 'session-a' }),
    ).rejects.toThrow();

    expect(graph.statements).toHaveLength(0);
    expect(listReflectionJobs(db)).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('rejects an unknown field rather than storing it', async () => {
    await expect(
      handleReflection(deps, { observations: ['ok'], mood: 'curious' }, { identity: 'session-a' }),
    ).rejects.toThrow();

    expect(graph.statements).toHaveLength(0);
  });
});

describe('reflection intake redaction', () => {
  it('redacts every payload string before it reaches the graph or the embedder', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(graph.writtenText()).not.toContain(AWS_KEY);
    expect(graph.writtenText()).not.toContain(GITHUB_TOKEN);
    expect(embeddedTexts(0)).not.toContain(AWS_KEY);
    expect(embeddedTexts(0)).not.toContain(GITHUB_TOKEN);

    const episodeText = graph.nodes.get(result.episode_id)?.properties.text as string;
    expect(episodeText).toContain('⟨secret:aws-access-key:');
    expect(episodeText).toContain('⟨secret:github-token:');
  });

  it('leaves the caller-supplied session identity intact', async () => {
    await handleReflection(deps, { ...PAYLOAD, session_id: 'mcp-transport-42' }, { identity: 'unused' });

    expect(graph.nodesWithLabel('Session').map((node) => node.id)).toEqual(['mcp-transport-42']);
  });
});

describe('reflection intake storage', () => {
  it('stores the episode, its turns, and the backbone edges', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    const episode = graph.nodes.get(result.episode_id);
    expect(episode?.labels).toEqual(['Episode', 'Memory', 'AionNode']);
    expect(episode?.properties).toMatchObject({
      summary: PAYLOAD.summary,
      session_id: 'session-a',
      turn_count: 2,
      tool_execution_count: 1,
      observation_count: 1,
      extraction_method: 'reflection_intake',
    });
    expect(episode?.properties.content_hash).toEqual(expect.any(String));
    expect((episode?.properties.content_vec as number[]).length).toBe(EMBED_DIMENSION);

    const turns = graph.nodesWithLabel('Turn');
    expect(turns.map((turn) => turn.properties.sequence)).toEqual([0, 1]);
    expect(turns.map((turn) => turn.properties.role)).toEqual(['user', 'assistant']);
    expect(turns.every((turn) => turn.properties.source_episode_id === result.episode_id)).toBe(true);

    const containment = graph.edgesOfType('PARTICIPATES_IN');
    expect(containment).toHaveLength(3);
    expect(containment.some((edge) => edge.sourceId === result.episode_id && edge.targetId === 'session-a')).toBe(true);
    expect(turns.every((turn) => containment.some((edge) => edge.sourceId === turn.id && edge.targetId === result.episode_id))).toBe(true);

    const turnFollows = graph.edgesOfType('FOLLOWS').filter((edge) => edge.sourceId === turns[1]?.id);
    expect(turnFollows).toHaveLength(1);
    expect(turnFollows[0]?.targetId).toBe(turns[0]?.id);
  });

  it('embeds the episode body and every turn in one batched call', async () => {
    await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(embed).toHaveBeenCalledTimes(1);
    expect((embed.mock.calls[0]?.[0] as readonly string[]).length).toBe(3);
  });

  it('enqueues exactly one integrate job carrying the episode id and signals the dispatcher', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    const jobs = listReflectionJobs(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe(INTEGRATE_JOB_TYPE);
    expect(jobs[0]?.payload).toEqual({ episode_id: result.episode_id });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      jobId: jobs[0]?.id,
      jobType: INTEGRATE_JOB_TYPE,
      episodeId: result.episode_id,
      sessionId: 'session-a',
    });
  });

  it('never calls the generation path', async () => {
    await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(generate).not.toHaveBeenCalled();
  });
});

describe('reflection intake dedupe', () => {
  it('returns the original episode id for the same payload in the same session', async () => {
    const first = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });
    const nodesAfterFirst = graph.nodes.size;

    const second = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(second.episode_id).toBe(first.episode_id);
    expect(second.queued).toBe(true);
    expect(graph.nodes.size).toBe(nodesAfterFirst);
    expect(listReflectionJobs(db)).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  // The member lock serializes session creation, the session lock serializes intake for
  // that session; the ordering that makes each work is proven against a real server in the
  // integration suites.
  it('takes the session write lock while storing the episode', async () => {
    await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(graph.locked).toEqual([MEMBER_ID, 'session-a']);
  });

  it('queues the episode again when its job row is gone but the episode is not', async () => {
    const first = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    // The job ran to completion, which discards the row. The episode is still the record.
    const claimant = new ReflectionQueueClaimant();
    const claimed = claimant.claimNext(db);
    expect(claimant.complete(db, claimed?.id ?? '')).toBe(true);

    const second = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(second.episode_id).toBe(first.episode_id);
    expect(listReflectionJobs(db)).toHaveLength(1);
    expect(signals).toHaveLength(2);
  });

  it('stores the same payload again when it arrives in a different session', async () => {
    const first = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });
    const second = await handleReflection(deps, PAYLOAD, { identity: 'session-b' });

    expect(second.episode_id).not.toBe(first.episode_id);
    expect(listReflectionJobs(db)).toHaveLength(2);
  });

  it('stores a new episode when any content field changes', async () => {
    const first = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });
    const second = await handleReflection(
      deps,
      { ...PAYLOAD, observations: ['a different conclusion'] },
      { identity: 'session-a' },
    );

    expect(second.episode_id).not.toBe(first.episode_id);
  });
});
