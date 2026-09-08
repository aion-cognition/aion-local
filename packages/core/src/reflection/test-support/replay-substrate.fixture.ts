import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeGraph } from './fake-graph.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  getExperienceByEpisode,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { SessionManager } from '../../session/session-manager.js';
import type {
  ReflectionRun,
  ReflectionRunOptions,
  ReflectionRunStatus,
} from '../application/orchestrator.js';
import type { ReplayDeps } from '../application/replay.js';
import type { ReflectionContent } from '../domain/content.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * The substrate a replay test runs against: an in-memory graph, a real SQLite store, and a
 * runner that answers from a script instead of running stages.
 *
 * It is shared because two files exercise the same pass from different angles: what a replay
 * enumerates and counts, and what it does about a source's identity and storage. One setup keeps
 * them describing the same substrate rather than two that drift apart.
 */
export const MEMBER_ID = 'member-1';
export const WORKSPACE_ID = 'workspace-1';
export const IDENTITY = 'replay-session';
export const ARCHIVED_AT = '2026-09-01T12:00:00.000Z';

/** The moment the replay itself happens, months after the newest experience it puts back. */
export const WALL_NOW = new Date('2026-09-01T17:45:00.000Z');

/** Five experiences, a day apart, archived out of order so ordering is the runner's doing. */
export const OCCURRED = [
  '2026-01-01T08:00:00.000Z',
  '2026-01-02T08:00:00.000Z',
  '2026-01-03T08:00:00.000Z',
  '2026-01-04T08:00:00.000Z',
  '2026-01-05T08:00:00.000Z',
] as const;

export type RunCall = {
  readonly episodeId: string;
  readonly options: ReflectionRunOptions;
};

/** What the fake runner does on one call: answer with a status, or throw the way a stage can. */
export type RunAnswer = ReflectionRunStatus | 'throws';

export type ReplaySubstrate = {
  readonly graph: FakeGraph;
  readonly store: SqliteStore;
  readonly dataDir: string;
  readonly deps: ReplayDeps;
  readonly calls: RunCall[];
  /** Answers in call order; the runner completes once the list runs out. */
  readonly answers: RunAnswer[];
};

export function contentFor(index: number): ReflectionContent {
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

function summaryOf(episodeId: string, status: ReflectionRunStatus): ReflectionRun {
  return {
    episodeId,
    status,
    applied: status === 'completed',
    summary: { episodeId, durationMs: 0, counts: {}, stages: [], skippedStages: [] },
  };
}

export function openReplaySubstrate(): ReplaySubstrate {
  const graph = new FakeGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode']);
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode']);
  const dataDir = mkdtempSync(join(tmpdir(), 'aion-replay-'));
  const store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  const calls: RunCall[] = [];
  const answers: RunAnswer[] = [];
  return {
    graph,
    store,
    dataDir,
    calls,
    answers,
    deps: replayDeps(graph.driver, store, dataDir, calls, answers),
  };
}

export function replayDeps(
  driver: Driver,
  store: SqliteStore,
  dataDir: string,
  calls: RunCall[],
  answers: RunAnswer[],
): ReplayDeps {
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

export function closeReplaySubstrate(substrate: ReplaySubstrate): void {
  substrate.store.close();
  rmSync(substrate.dataDir, { recursive: true, force: true });
}

/** Archives one experience and answers with the archive row's own id. */
export function archiveExperience(
  substrate: ReplaySubstrate,
  index: number,
  pipelineVersion: string = PIPELINE_VERSION,
): string {
  const episodeId = `archived-episode-${String(index)}`;
  const inserted = insertExperience(substrate.store.db, {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion,
    identity: IDENTITY,
    sessionId: IDENTITY,
    episodeId,
    contentHash: `hash-${String(index)}`,
    occurredAt: OCCURRED[index] ?? ARCHIVED_AT,
    archivedAt: ARCHIVED_AT,
    payload: contentFor(index),
  });
  if (!inserted) {
    throw new Error(`experience ${episodeId} was already archived`);
  }
  return getExperienceByEpisode(substrate.store.db, episodeId)?.id ?? '';
}

/** Reverse insertion order, so a runner that read rows by rowid would fail the ordering test. */
export function archiveAllExperiences(substrate: ReplaySubstrate): void {
  for (const index of [4, 2, 0, 3, 1]) {
    archiveExperience(substrate, index);
  }
}

/** A driver whose every call fails the way an unreachable server does, code and all. */
export function unavailableDriver(): Driver {
  const fail = (): never => {
    const err = new Error('connection refused') as Error & { code: string };
    err.code = 'ServiceUnavailable';
    throw err;
  };
  return { executeQuery: fail, session: fail } as unknown as Driver;
}
