import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

describe('handleReflectionResult', () => {
  it('passes an accepted push through unchanged', async () => {
    const wrapped = await handleReflectionResult(
      deps,
      { observations: ['ordinary push, no birth fence in play'] },
      { identity: 'session-a' },
    );

    expect(wrapped).toMatchObject({ queued: true, lane: 'interactive' });
    expect('pre_birth_trim' in wrapped).toBe(false);
  });

  it('turns a full pre-birth refusal into the disclosed refusal branch', async () => {
    seedBirth();
    const payload = {
      turns: [{ role: 'user', text: 'from before init', occurred_at: '2026-09-14T10:02:10Z' }],
    };

    const result = await handleReflectionResult(deps, payload, { identity: 'session-a' });

    expect(result).toEqual({
      status: 'pre_birth_refusal',
      substrate_born_at: BIRTH.toISOString(),
      pre_birth_refused: { turns: 1, tool_executions: 0 },
    });
    expect(graph.nodesWithLabel('Episode')).toHaveLength(0);
  });

  it('still discloses a partial trim on the accepted branch, same as calling handleReflection directly', async () => {
    seedBirth();
    const payload = {
      turns: [
        { role: 'user', text: 'before init', occurred_at: '2026-09-14T10:02:10Z' },
        { role: 'assistant', text: 'after init', occurred_at: '2026-09-14T10:09:12Z' },
      ],
    };

    const result = await handleReflectionResult(deps, payload, { identity: 'session-a' });

    expect(result).toMatchObject({
      queued: true,
      pre_birth_trim: { turns: 1, tool_executions: 0 },
    });
  });

  it('lets an unrelated failure propagate rather than swallowing it as a refusal', async () => {
    await expect(
      handleReflectionResult(deps, { summary: 'nothing happened' }, { identity: 'session-a' }),
    ).rejects.toThrow();
  });
});
