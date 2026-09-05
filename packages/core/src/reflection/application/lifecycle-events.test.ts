import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { recordLifecycleEvent } from './lifecycle-events.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { SYSTEM_SESSION_IDENTITY } from '../../infrastructure/graph/sessions.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listExperiencesAfter } from '../../infrastructure/sqlite/experience-archive.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import { SessionManager } from '../../session/session-manager.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-1';
const SUBSTRATE_ID = 'substrate-1';
const EMBED_DIMENSION = 8;

const BIRTH_TEXT =
  'substrate initialized: 7 migrations applied, backbone created for Ryan Huber, profile full';
const RECORDED_AT = new Date('2026-09-05T09:00:00.000Z');

let graph: FakeGraph;
let db: SqliteHandle;
let dataDir: string;
let deps: ReflectionIntakeDeps;

function fakeVectors(texts: readonly string[]): Vector[] {
  return texts.map(() => Array.from({ length: EMBED_DIMENSION }, () => 0.5));
}

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode']);
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode']);
  graph.seedNode(SUBSTRATE_ID, ['Substrate', 'Entity', 'AionNode']);

  dataDir = mkdtempSync(join(tmpdir(), 'aion-lifecycle-events-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });

  deps = {
    driver: graph.driver,
    db,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    provider: {
      embed: vi.fn((texts: readonly string[]) => Promise.resolve(fakeVectors(texts))),
      generate: vi.fn(() => Promise.reject(new Error('a lifecycle event never generates'))),
    },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
  };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A driver whose every call fails the way an unreachable server does, code and all. */
function unavailableDriver(): Driver {
  const fail = (): never => {
    const err = new Error('connection refused') as Error & { code: string };
    err.code = 'ServiceUnavailable';
    throw err;
  };
  return { executeQuery: fail, session: fail } as unknown as Driver;
}

describe('recording a lifecycle event', () => {
  it('stores the text as an observation in the session the substrate keeps for itself', async () => {
    await recordLifecycleEvent(deps, {
      event: 'substrate_initialized',
      text: BIRTH_TEXT,
      now: RECORDED_AT,
    });

    const rows = listExperiencesAfter(db, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      identity: SYSTEM_SESSION_IDENTITY,
      sessionId: SYSTEM_SESSION_IDENTITY,
      lane: 'bulk',
      origin: { channel: 'system', event: 'substrate_initialized' },
    });
    expect(rows[0]?.payload).toEqual({ observations: [BIRTH_TEXT] });
  });

  it('queues the episode behind live turns rather than beside them', async () => {
    await recordLifecycleEvent(deps, { event: 'replay_completed', text: 'replay completed' });

    const jobs = listReflectionJobs(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.lane).toBe('bulk');
  });

  it('hangs the system session off the substrate instead of the member', async () => {
    await recordLifecycleEvent(deps, { event: 'substrate_initialized', text: BIRTH_TEXT });

    const initiated = graph.edgesOfType('INITIATED_BY');
    expect(initiated).toHaveLength(1);
    expect(initiated[0]).toMatchObject({
      sourceId: SYSTEM_SESSION_IDENTITY,
      targetId: SUBSTRATE_ID,
    });
    expect(graph.edgesOfType('FOLLOWS')).toHaveLength(0);
  });

  it('chains every event in the one session', async () => {
    await recordLifecycleEvent(deps, { event: 'substrate_initialized', text: BIRTH_TEXT });
    await recordLifecycleEvent(deps, {
      event: 'models_reconciled',
      text: 'boot unloaded qwen3:8b from memory',
    });

    const rows = listExperiencesAfter(db, undefined, 10);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sessionId))).toEqual(new Set([SYSTEM_SESSION_IDENTITY]));
    expect(graph.nodesWithLabel('Session')).toHaveLength(1);
  });

  it('reports rather than throws when the substrate cannot store the event', async () => {
    const severed = unavailableDriver();
    const offline: ReflectionIntakeDeps = {
      ...deps,
      driver: severed,
      sessions: new SessionManager(severed, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    };

    await expect(
      recordLifecycleEvent(offline, { event: 'substrate_initialized', text: BIRTH_TEXT }),
    ).resolves.toBeUndefined();
    expect(listExperiencesAfter(db, undefined, 10)).toHaveLength(0);
  });
});
