import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { handleReflectionResult } from './reflection-result.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { SessionManager } from '../../session/session-manager.js';
import { directIntakePublisher } from '../test-support/direct-intake.fixture.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

/**
 * `handleReflectionResult` is the one seam that also answers for a push the birth fence
 * refused outright: `handleReflection` throws for that case (proven directly in
 * `intake.test.ts`), and this proves the wrapper turns that throw into the disclosed refusal a
 * tool client sees, while a push it does not throw for still comes back exactly as
 * `handleReflection` returned it.
 */

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-1';
const BIRTH = new Date('2026-09-14T10:07:37.000Z');

let graph: FakeGraph;
let db: SqliteHandle;
let dataDir: string;
let deps: ReflectionIntakeDeps;

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode']);
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode']);

  dataDir = mkdtempSync(join(tmpdir(), 'aion-reflection-result-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });

  deps = {
    driver: graph.driver,
    db,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: 4.5,
    lanes: new LaneAssigner({
      arrivalWindowMs: 60_000,
      sessionArrivalMax: 50,
      globalArrivalMax: 50,
      hotSessionArrivalMax: 50,
    }),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications: directIntakePublisher(graph.driver, db, () => BIRTH),
  };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seedBirth(): void {
  const pairing = readSubstratePairing(db);
  if (pairing === undefined) {
    throw new Error('the fixture pairs a substrate at beforeEach; nothing to seed a birth for');
  }
  graph.seedPublicationGuard(pairing.substrateId, BIRTH.toISOString());
}

it('refuses every pre-birth payload before publication leaves archive, graph or queue records', async () => {
  seedBirth();
  const result = await handleReflectionResult(
    deps,
    {
      turns: [{ role: 'user', text: 'PREBIRTH-REJECTED', occurred_at: '2026-09-14T10:01:00Z' }],
      tool_executions: [
        { tool: 'read', status: 'ok', input: 'PREBIRTH-TOOL', occurred_at: '2026-09-14T10:02:00Z' },
      ],
    },
    { identity: 'session-a' },
  );
  expect(result).toMatchObject({
    status: 'pre_birth_refusal',
    pre_birth_refused: { turns: 1, tool_executions: 1 },
  });
  expect(graph.nodesWithLabel('Episode')).toHaveLength(0);
  expect(db.prepare('SELECT count(*) AS n FROM experience_archive').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) AS n FROM reflection_queue').get()).toEqual({ n: 0 });
});

it('mixed publication and retry keep only accepted content in both durable and graph stores', async () => {
  seedBirth();
  const payload = {
    turns: [
      { role: 'user', text: 'PREBIRTH-REJECTED', occurred_at: '2026-09-14T10:01:00Z' },
      { role: 'assistant', text: 'I remember an event in 1995', occurred_at: BIRTH.toISOString() },
    ],
    tool_executions: [
      { tool: 'read', status: 'ok', input: 'PREBIRTH-TOOL', occurred_at: '2026-09-14T10:02:00Z' },
    ],
  };
  const first = await handleReflectionResult(deps, payload, { identity: 'session-a' });
  const second = await handleReflectionResult(deps, payload, { identity: 'session-a' });
  expect(first).toMatchObject({ queued: true, pre_birth_trim: { turns: 1, tool_executions: 1 } });
  expect(second).toEqual(first);
  expect(graph.nodesWithLabel('Turn')).toHaveLength(1);
  expect(graph.nodesWithLabel('Turn')[0]?.properties.text).toBe('I remember an event in 1995');
  const rows = db.prepare('SELECT payload_json FROM experience_archive').all();
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain('PREBIRTH');
  expect(JSON.stringify(graph.nodesWithLabel('Episode'))).not.toContain('PREBIRTH');
  expect(
    JSON.stringify(db.prepare('SELECT payload_json FROM reflection_queue').all()),
  ).not.toContain('PREBIRTH');
});
