import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { SessionManager } from '../../session/session-manager.js';
import { directIntakePublisher } from '../test-support/direct-intake.fixture.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-1';
const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-08T06:00:00.000Z');

const PAYLOAD = {
  turns: [
    { role: 'user', text: 'why did the sync key on id_slug' },
    { role: 'assistant', text: 'the external ids churn' },
  ],
  observations: ['keyed the sync on id_slug'],
};

let graph: FakeGraph;
let db: SqliteHandle;
let dataDir: string;
let deps: ReflectionIntakeDeps;

function fakeVectors(texts: readonly string[]): Vector[] {
  return texts.map((_unused, index) =>
    Array.from({ length: EMBED_DIMENSION }, (__unused, slot) => (index + 1) / (slot + 1)),
  );
}

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode']);
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode']);
  dataDir = mkdtempSync(join(tmpdir(), 'aion-intake-identity-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  deps = {
    driver: graph.driver,
    db,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    provider: {
      embed: vi.fn((texts: readonly string[]) => Promise.resolve(fakeVectors(texts))),
      generate: vi.fn(() => Promise.reject(new Error('intake must never call generate'))),
    },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: 4.5,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications: directIntakePublisher(graph.driver, db),
    acceptHookCapture: true,
  };
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('keeps original fallback part clocks on an unchanged duplicate', async () => {
  const first = await handleReflection(deps, PAYLOAD, { identity: 'session-a', now: NOW });
  const rows = () =>
    db
      .prepare(
        "SELECT ordinal, occurred_at FROM source_parts WHERE source_id=? AND part_kind='turn' ORDER BY ordinal",
      )
      .all(first.episode_id);
  const before = rows();
  await handleReflection(deps, PAYLOAD, {
    identity: 'session-a',
    now: new Date(NOW.getTime() + 60000),
  });
  expect(rows()).toEqual(before);
});
