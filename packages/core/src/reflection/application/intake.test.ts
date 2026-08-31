import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleReflection, INTEGRATE_JOB_TYPE, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  enqueueReflectionJob,
  listReflectionJobs,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { SessionManager } from '../../session/session-manager.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-1';
const EMBED_DIMENSION = 8;

/** Small enough that a handful of pushes crosses it, so the backstop is testable in a unit. */
const LANE_LIMITS = {
  arrivalWindowMs: 60_000,
  sessionArrivalMax: 2,
  globalArrivalMax: 3,
  hotSessionArrivalMax: 1,
};

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
let enqueuedJobIds: string[];
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

  enqueuedJobIds = [];

  embed = vi.fn((texts: readonly string[]) => Promise.resolve(fakeVectors(texts)));
  generate = vi.fn(() => Promise.reject(new Error('intake must never call generate')));

  deps = {
    driver: graph.driver,
    db,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    provider: { embed, generate } as unknown as ReflectionIntakeDeps['provider'],
    onJobEnqueued: (jobId: string) => {
      enqueuedJobIds.push(jobId);
    },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: 4.5,
    lanes: new LaneAssigner(LANE_LIMITS),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function embeddedTexts(call: number): string {
  return (embed.mock.calls[call]?.[0] as readonly string[]).join('\n');
}

/** Pino's numeric levels, which is what the JSONL line carries. */
const PINO_INFO = 30;
const PINO_WARN = 40;

type LogLine = { readonly level: number; readonly msg: string; readonly reason?: string };

function logLines(filePath: string): LogLine[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogLine);
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
    await handleReflection(
      deps,
      { ...PAYLOAD, session_id: 'mcp-transport-42' },
      { identity: 'unused' },
    );

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
    expect(turns.every((turn) => turn.properties.source_episode_id === result.episode_id)).toBe(
      true,
    );

    const containment = graph.edgesOfType('PARTICIPATES_IN');
    expect(containment).toHaveLength(3);
    expect(
      containment.some(
        (edge) => edge.sourceId === result.episode_id && edge.targetId === 'session-a',
      ),
    ).toBe(true);
    expect(
      turns.every((turn) =>
        containment.some(
          (edge) => edge.sourceId === turn.id && edge.targetId === result.episode_id,
        ),
      ),
    ).toBe(true);

    const turnFollows = graph
      .edgesOfType('FOLLOWS')
      .filter((edge) => edge.sourceId === turns[1]?.id);
    expect(turnFollows).toHaveLength(1);
    expect(turnFollows[0]?.targetId).toBe(turns[0]?.id);
  });

  it('stores the origin channel and event when the caller names one', async () => {
    const result = await handleReflection(
      deps,
      { ...PAYLOAD, origin: { channel: 'hook', event: 'subagent-stop' } },
      { identity: 'session-a' },
    );

    const episode = graph.nodes.get(result.episode_id);
    expect(episode?.properties).toMatchObject({
      origin_channel: 'hook',
      origin_event: 'subagent-stop',
    });
  });

  it('writes no origin property at all when the caller names none', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    const episode = graph.nodes.get(result.episode_id);
    expect(episode?.properties.origin_channel).toBeUndefined();
    expect(episode?.properties.origin_event).toBeUndefined();
  });

  it('embeds the episode body and every turn in one batched call', async () => {
    await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(embed).toHaveBeenCalledTimes(1);
    expect((embed.mock.calls[0]?.[0] as readonly string[]).length).toBe(3);
  });

  it('enqueues exactly one integrate job carrying the episode id and wakes the worker once', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    const jobs = listReflectionJobs(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe(INTEGRATE_JOB_TYPE);
    expect(jobs[0]?.payload).toEqual({ episode_id: result.episode_id });

    expect(enqueuedJobIds).toEqual([jobs[0]?.id]);
  });

  it('never calls the generation path', async () => {
    await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(generate).not.toHaveBeenCalled();
  });

  // A caller re-pushing an experience the substrate already holds is how an operator tells a
  // retry storm from real traffic, and at debug it was invisible at the level production runs.
  it('reports a deduplicated push at info', async () => {
    const logPath = join(dataDir, 'dedupe.jsonl');
    const watched: ReflectionIntakeDeps = {
      ...deps,
      logger: openLogger({ filePath: logPath, level: 'debug' }),
    };

    await handleReflection(watched, PAYLOAD, { identity: 'session-a' });
    await handleReflection(watched, PAYLOAD, { identity: 'session-a' });

    const deduped = logLines(logPath).filter(
      (line) => line.msg === 'reflection payload already stored',
    );
    expect(deduped.map((line) => line.level)).toEqual([PINO_INFO]);
  });
});

describe('reflection intake lanes', () => {
  function payload(index: number): Record<string, unknown> {
    return { observations: [`episode number ${String(index)}`] };
  }

  it('acks the interactive lane and stamps it on the queue row', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(result.lane).toBe('interactive');
    expect(listReflectionJobs(db)[0]).toMatchObject({
      lane: 'interactive',
      sessionId: 'session-a',
    });
  });

  it('honours an explicit bulk flag and echoes it', async () => {
    const result = await handleReflection(
      deps,
      { ...PAYLOAD, lane: 'bulk' },
      { identity: 'session-a' },
    );

    expect(result.lane).toBe('bulk');
    expect(listReflectionJobs(db)[0]?.lane).toBe('bulk');
  });

  // The flag can only ever cost a caller priority. Taking `interactive` at face value would
  // make the backstop opt-in for exactly the client that will not opt in.
  it('does not let an explicit interactive flag escape the backstop', async () => {
    for (let index = 0; index < 2; index += 1) {
      await handleReflection(deps, payload(index), { identity: 'session-a' });
    }

    const demoted = await handleReflection(
      deps,
      { ...payload(2), lane: 'interactive' },
      { identity: 'session-a' },
    );

    expect(demoted.lane).toBe('bulk');
  });

  it('demotes a session past its arrival threshold and leaves a quiet session alone', async () => {
    const lanes: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      lanes.push((await handleReflection(deps, payload(index), { identity: 'noisy' })).lane);
    }
    const quiet = await handleReflection(deps, payload(99), { identity: 'quiet' });

    expect(lanes).toEqual(['interactive', 'interactive', 'bulk']);
    expect(quiet.lane).toBe('interactive');
  });

  // Re-pushing a payload the substrate already holds is not new work; counting it would let a
  // retrying client demote itself for an episode that is already queued.
  it('does not count a duplicate payload as an arrival', async () => {
    await handleReflection(deps, PAYLOAD, { identity: 'session-a' });
    await handleReflection(deps, PAYLOAD, { identity: 'session-a' });
    const third = await handleReflection(deps, payload(1), { identity: 'session-a' });

    expect(third.lane).toBe('interactive');
  });

  // The lane is scheduling metadata. In the content hash it would make one experience two
  // episodes depending on which queue it waited in.
  it('keeps the lane out of the content hash', async () => {
    const interactive = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });
    const bulk = await handleReflection(
      deps,
      { ...PAYLOAD, lane: 'bulk' },
      { identity: 'session-a' },
    );

    expect(bulk.episode_id).toBe(interactive.episode_id);
    expect(listReflectionJobs(db)).toHaveLength(1);
  });

  // Origin is provenance about the call, not about what happened. In the content hash it
  // would make the same experience two episodes depending on which transport pushed it.
  it('keeps origin out of the content hash', async () => {
    const bare = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });
    const withOrigin = await handleReflection(
      deps,
      { ...PAYLOAD, origin: { channel: 'hook', event: 'stop' } },
      { identity: 'session-a' },
    );

    expect(withOrigin.episode_id).toBe(bare.episode_id);
    expect(listReflectionJobs(db)).toHaveLength(1);
  });

  // A caller that asked for the bulk lane got what it asked for. Warning on it read the same
  // as the rate backstop tripping, which is the only one of the two an operator has to act on.
  it('logs a requested demotion at info and a rate-tripped one at warn', async () => {
    const logPath = join(dataDir, 'lanes.jsonl');
    const watched: ReflectionIntakeDeps = {
      ...deps,
      logger: openLogger({ filePath: logPath, level: 'debug' }),
    };

    await handleReflection(watched, { ...PAYLOAD, lane: 'bulk' }, { identity: 'asked' });
    for (let index = 0; index < 3; index += 1) {
      await handleReflection(watched, payload(index), { identity: 'noisy' });
    }

    const bulk = logLines(logPath).filter(
      (line) => line.msg === 'reflection queued in the bulk lane',
    );
    expect(bulk.map((line) => [line.reason, line.level])).toEqual([
      ['requested', PINO_INFO],
      ['session-rate', PINO_WARN],
    ]);
  });
});

describe('reflection intake pending_ahead', () => {
  it('reports zero ahead of the first job into an empty queue', async () => {
    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(result.pending_ahead).toBe(0);
  });

  it('counts unclaimed interactive rows already queued, measured before this job lands', async () => {
    for (let index = 0; index < 3; index += 1) {
      enqueueReflectionJob(
        db,
        INTEGRATE_JOB_TYPE,
        { episode_id: `seed-${String(index)}` },
        { lane: 'interactive' },
      );
    }

    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(result.pending_ahead).toBe(3);
    // The count excludes this call's own row: four jobs now queued, three were ahead of it.
    expect(listReflectionJobs(db)).toHaveLength(4);
  });

  it('ignores unclaimed bulk rows: only the interactive lane can be ahead of a caller', async () => {
    enqueueReflectionJob(db, INTEGRATE_JOB_TYPE, { episode_id: 'bulk-seed' }, { lane: 'bulk' });

    const result = await handleReflection(deps, PAYLOAD, { identity: 'session-a' });

    expect(result.pending_ahead).toBe(0);
  });

  it('still counts the interactive backlog when this call itself queues in bulk', async () => {
    enqueueReflectionJob(db, INTEGRATE_JOB_TYPE, { episode_id: 'seed-0' }, { lane: 'interactive' });
    enqueueReflectionJob(db, INTEGRATE_JOB_TYPE, { episode_id: 'seed-1' }, { lane: 'interactive' });

    const result = await handleReflection(
      deps,
      { ...PAYLOAD, lane: 'bulk' },
      { identity: 'session-a' },
    );

    expect(result.lane).toBe('bulk');
    expect(result.pending_ahead).toBe(2);
  });
});
