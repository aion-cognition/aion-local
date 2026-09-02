import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReflectionNotStoredError } from './errors.js';
import type { ReflectionRun, ReflectionRunOptions, ReflectionRunStatus } from './orchestrator.js';
import { replayExperiences, type ReplayDeps, type ReplayProgress } from './replay.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { fromGraphDateTime } from '../../infrastructure/graph/values.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { SessionManager } from '../../session/session-manager.js';
import type { ReflectionContent } from '../domain/content.js';
import { PIPELINE_VERSION } from '../domain/version.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-1';
const IDENTITY = 'replay-session';
const ARCHIVED_AT = '2026-09-01T12:00:00.000Z';
/** The moment the replay itself happens, months after the newest experience it puts back. */
const WALL_NOW = new Date('2026-09-01T17:45:00.000Z');

/** Five experiences, a day apart, archived out of order so ordering is the runner's doing. */
const OCCURRED = [
  '2026-01-01T08:00:00.000Z',
  '2026-01-02T08:00:00.000Z',
  '2026-01-03T08:00:00.000Z',
  '2026-01-04T08:00:00.000Z',
  '2026-01-05T08:00:00.000Z',
] as const;

type RunCall = {
  readonly episodeId: string;
  readonly options: ReflectionRunOptions;
};

/** What the fake runner does on one call: answer with a status, or throw the way a stage can. */
type RunAnswer = ReflectionRunStatus | 'throws';

let graph: FakeGraph;
let store: SqliteStore;
let dataDir: string;
let deps: ReplayDeps;
let calls: RunCall[];
/** Answers in call order; the runner completes once the list runs out. */
let answers: RunAnswer[];

function contentFor(index: number): ReflectionContent {
  return {
    turns: [
      {
        role: 'user',
        text: `why did we pick option ${String(index)}`,
        occurred_at: OCCURRED[index],
      },
    ],
    summary: `option ${String(index)}`,
  };
}

function archive(index: number, pipelineVersion: string = PIPELINE_VERSION): void {
  const inserted = insertExperience(store.db, {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion,
    identity: IDENTITY,
    sessionId: IDENTITY,
    episodeId: `archived-episode-${String(index)}`,
    contentHash: `hash-${String(index)}`,
    occurredAt: OCCURRED[index] ?? ARCHIVED_AT,
    archivedAt: ARCHIVED_AT,
    payload: contentFor(index),
  });
  expect(inserted).toBe(true);
}

function archiveAll(): void {
  // Reverse insertion order, so a runner that read rows by rowid would fail the ordering test.
  for (const index of [4, 2, 0, 3, 1]) {
    archive(index);
  }
}

function summaryOf(episodeId: string, status: ReflectionRunStatus): ReflectionRun {
  return {
    episodeId,
    status,
    applied: status === 'completed',
    summary: { episodeId, durationMs: 0, counts: {}, stages: [], skippedStages: [] },
  };
}

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode']);
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode']);
  dataDir = mkdtempSync(join(tmpdir(), 'aion-replay-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  calls = [];
  answers = [];
  deps = depsOn(graph.driver);
});

function depsOn(driver: Driver): ReplayDeps {
  return {
    driver,
    sessions: new SessionManager(driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    db: store.db,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    runner: {
      run: (episodeId, options) => {
        calls.push({ episodeId, options });
        const answer = answers.shift() ?? 'completed';
        if (answer === 'throws') {
          return Promise.reject(new Error('the stage exploded'));
        }
        return Promise.resolve(summaryOf(episodeId, answer));
      },
    },
  };
}

/** A driver whose every call fails the way an unreachable server does, code and all. */
function unavailableDriver(): Driver {
  const fail = (): never => {
    const err = new Error('connection refused') as Error & { code: string };
    err.code = 'ServiceUnavailable';
    throw err;
  };
  return { executeQuery: fail, session: fail } as unknown as Driver;
}

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function stampOf(episodeId: string, property: string): string {
  const stamp = fromGraphDateTime(graph.nodes.get(episodeId)?.properties[property]);
  return stamp?.toISOString() ?? 'missing';
}

/**
 * World time on the episode each run was handed, which identifies the archived row it came
 * from: the rows are a day apart and nothing else about them differs.
 */
function worldClocks(): string[] {
  return calls.map((call) => stampOf(call.episodeId, BITEMPORAL_PROPERTIES.occurredAt));
}

/** Transaction time on those same episodes: the moment the replay committed them. */
function txClocks(): string[] {
  return calls.map((call) => stampOf(call.episodeId, BITEMPORAL_PROPERTIES.txFrom));
}

/** The clock each run was handed, which stamps its writes and ages its locks. */
function runClocks(): string[] {
  return calls.map((call) => (call.options.now ?? new Date(0)).toISOString());
}

describe('replaying the whole archive', () => {
  it('visits every row once, oldest first, across three batches of two', async () => {
    archiveAll();
    const batches: ReplayProgress[] = [];

    const report = await replayExperiences(deps, {
      batchSize: 2,
      onBatch: (progress) => batches.push(progress),
    });

    expect(report.scanned).toBe(5);
    expect(report.replayed).toBe(5);
    expect(new Set(calls.map((call) => call.episodeId)).size).toBe(5);
    expect(worldClocks()).toEqual([...OCCURRED]);
    expect(batches.map((batch) => batch.scanned)).toEqual([2, 4, 5]);
    expect(batches.map((batch) => batch.cursor.occurredAt)).toEqual([
      OCCURRED[1],
      OCCURRED[3],
      OCCURRED[4],
    ]);
    expect(report.cursor?.occurredAt).toBe(OCCURRED[4]);
    expect(report.aborted).toBe(false);
  });

  it('dates each experience to when it happened and each write to the replay', async () => {
    archiveAll();

    await replayExperiences(deps, { batchSize: 10, clock: () => WALL_NOW });

    // World time is the archived row's: a re-derived episode is dated to the conversation.
    expect(worldClocks()).toEqual([...OCCURRED]);
    // Transaction time is the replay's, on the run and on what the run wrote alike. Taking it
    // from the row instead would record a write the substrate never made in January.
    const replayed = Array(OCCURRED.length).fill(WALL_NOW.toISOString());
    expect(runClocks()).toEqual(replayed);
    expect(txClocks()).toEqual(replayed);
    for (const call of calls) {
      expect(call.options.pipelineVersion).toBe(PIPELINE_VERSION);
    }
  });

  it('gates every run on the version it was asked for', async () => {
    archiveAll();

    await replayExperiences(deps, { batchSize: 10, pipelineVersion: 'v2' });

    expect(calls.map((call) => call.options.pipelineVersion)).toEqual(Array(5).fill('v2'));
  });

  it('stops after the row limit even when more pages are waiting', async () => {
    archiveAll();

    const report = await replayExperiences(deps, { batchSize: 2, limit: 3 });

    expect(report.scanned).toBe(3);
    expect(worldClocks()).toEqual([OCCURRED[0], OCCURRED[1], OCCURRED[2]]);
  });

  it('reports nothing scanned against an empty archive', async () => {
    const report = await replayExperiences(deps, { batchSize: 2 });

    expect(report).toEqual({
      scanned: 0,
      replayed: 0,
      skipped: 0,
      unavailable: 0,
      failed: 0,
      cursor: undefined,
      aborted: false,
    });
    expect(calls).toEqual([]);
  });
});

describe('selecting which archived rows replay', () => {
  it('takes only the rows another pipeline version wrote', async () => {
    archive(0, 'v0');
    archive(1);
    archive(2, 'v0');

    const report = await replayExperiences(deps, { batchSize: 10, selection: { stale: true } });

    expect(report.scanned).toBe(2);
    expect(worldClocks()).toEqual([OCCURRED[0], OCCURRED[2]]);
  });

  it('takes one archived episode by id', async () => {
    archiveAll();

    const report = await replayExperiences(deps, {
      batchSize: 10,
      selection: { episodeId: 'archived-episode-3' },
    });

    expect(report.scanned).toBe(1);
    expect(worldClocks()).toEqual([OCCURRED[3]]);
  });

  it('takes one session and leaves the rest of the archive alone', async () => {
    archiveAll();
    insertExperience(store.db, {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      identity: 'other-session',
      sessionId: 'other-session',
      episodeId: 'other-episode',
      contentHash: 'hash-other',
      occurredAt: OCCURRED[0],
      archivedAt: ARCHIVED_AT,
      payload: contentFor(0),
    });

    const report = await replayExperiences(deps, {
      batchSize: 10,
      selection: { sessionId: 'other-session' },
    });

    expect(report.scanned).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('what a replay counts', () => {
  it('counts a row the ledger already closed as skipped rather than replayed', async () => {
    archiveAll();
    answers = ['already_applied', 'already_applied', 'already_applied', 'already_applied'];

    const report = await replayExperiences(deps, { batchSize: 10 });

    expect({ replayed: report.replayed, skipped: report.skipped }).toEqual({
      replayed: 1,
      skipped: 4,
    });
  });

  it('counts an episode the graph cannot read back apart from a real replay', async () => {
    archiveAll();
    answers = ['episode_unavailable'];

    const report = await replayExperiences(deps, { batchSize: 10 });

    expect({ replayed: report.replayed, unavailable: report.unavailable }).toEqual({
      replayed: 4,
      unavailable: 1,
    });
  });

  it('counts a row whose run throws and keeps going through the rest', async () => {
    archiveAll();
    answers = ['completed', 'completed', 'throws'];

    const report = await replayExperiences(deps, { batchSize: 2 });

    expect({ scanned: report.scanned, replayed: report.replayed, failed: report.failed }).toEqual({
      scanned: 5,
      replayed: 4,
      failed: 1,
    });
    expect(worldClocks()).toEqual([...OCCURRED]);
  });

  it('stops the whole pass when the graph will not take a write', async () => {
    archiveAll();

    await expect(
      replayExperiences(depsOn(unavailableDriver()), { batchSize: 10 }),
    ).rejects.toBeInstanceOf(ReflectionNotStoredError);
    expect(calls).toEqual([]);
  });
});

describe('aborting a replay', () => {
  it('stops between batches and reports the cursor it reached', async () => {
    archiveAll();
    const controller = new AbortController();

    const report = await replayExperiences(deps, {
      batchSize: 2,
      signal: controller.signal,
      onBatch: () => {
        controller.abort();
      },
    });

    expect(report.aborted).toBe(true);
    expect(report.scanned).toBe(2);
    expect(report.cursor?.occurredAt).toBe(OCCURRED[1]);
    expect(report.cursor?.id).toEqual(expect.any(String));
    expect(calls).toHaveLength(2);
  });

  it('stops inside the batch, without running the rows behind the one that aborted it', async () => {
    archiveAll();
    const controller = new AbortController();
    const aborting: ReplayDeps = {
      ...deps,
      runner: {
        run: async (episodeId, options) => {
          controller.abort();
          return deps.runner.run(episodeId, options);
        },
      },
    };

    const report = await replayExperiences(aborting, {
      batchSize: 4,
      signal: controller.signal,
    });

    expect(report.aborted).toBe(true);
    expect(report.scanned).toBe(1);
    expect(report.cursor?.occurredAt).toBe(OCCURRED[0]);
    expect(calls).toHaveLength(1);
  });

  it('replays nothing when the signal is already aborted', async () => {
    archiveAll();

    const report = await replayExperiences(deps, {
      batchSize: 2,
      signal: AbortSignal.abort(),
    });

    expect({ aborted: report.aborted, scanned: report.scanned, cursor: report.cursor }).toEqual({
      aborted: true,
      scanned: 0,
      cursor: undefined,
    });
    expect(calls).toEqual([]);
  });
});
