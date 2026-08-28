import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapBackbone } from '../graph/backbone.js';
import { runRead } from '../graph/connection.js';
import { runGraphMigrations } from '../graph/migrations.js';
import { startNeo4jHarness, stopNeo4jHarness, type Neo4jHarness } from '../graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import { SessionManager } from './session-manager.js';

const EMBED_DIMENSION = 8;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let memberId: string;
let workspaceId: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-session-manager-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  memberId = backbone.member.id;
  workspaceId = backbone.workspace.id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function countFollowsEdges(fromId: string, toId: string): Promise<number> {
  const rows = await runRead(
    harness.driver,
    'MATCH (a:Session { id: $fromId })-[r:FOLLOWS]->(b:Session { id: $toId }) RETURN count(r) AS c',
    { fromId, toId },
    (row) => row.c as number,
  );
  return rows[0] ?? 0;
}

async function outgoingFollowsCount(sessionId: string): Promise<number> {
  const rows = await runRead(
    harness.driver,
    'MATCH (:Session { id: $sessionId })-[r:FOLLOWS]->(:Session) RETURN count(r) AS c',
    { sessionId },
    (row) => row.c as number,
  );
  return rows[0] ?? 0;
}

async function backboneEdgeTarget(sessionId: string, type: 'INITIATED_BY' | 'WITHIN_WORKSPACE'): Promise<string | undefined> {
  const rows = await runRead(
    harness.driver,
    `MATCH (:Session { id: $sessionId })-[:${type}]->(target) RETURN target.id AS id`,
    { sessionId },
    (row) => row.id as string,
  );
  return rows[0];
}

describe('SessionManager.ensureSession', () => {
  it('drives two interleaved session identities through one process without cross-linking', async () => {
    const manager = new SessionManager(harness.driver, { memberId, workspaceId });
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-01T00:05:00.000Z');
    const t3 = new Date('2026-01-01T00:10:00.000Z');
    const t4 = new Date('2026-01-01T00:15:00.000Z');

    // Interleaved: session-A's first call, session-B's first call, then each session
    // called again in the opposite order, simulating two agent sessions handled by one
    // service without either one's turns arriving back to back.
    const a1 = await manager.ensureSession({ identity: 'session-A', now: t1 });
    const b1 = await manager.ensureSession({ identity: 'session-B', now: t2 });
    const b2 = await manager.ensureSession({ identity: 'session-B', now: t3 });
    const a2 = await manager.ensureSession({ identity: 'session-A', now: t4 });

    expect(a1).toEqual({ sessionId: 'session-A', created: true });
    expect(b1).toEqual({ sessionId: 'session-B', created: true });
    expect(b2).toEqual({ sessionId: 'session-B', created: false });
    expect(a2).toEqual({ sessionId: 'session-A', created: false });

    // Separate nodes, each linked to the one backbone Member and global Workspace.
    expect(await backboneEdgeTarget('session-A', 'INITIATED_BY')).toBe(memberId);
    expect(await backboneEdgeTarget('session-A', 'WITHIN_WORKSPACE')).toBe(workspaceId);
    expect(await backboneEdgeTarget('session-B', 'INITIATED_BY')).toBe(memberId);
    expect(await backboneEdgeTarget('session-B', 'WITHIN_WORKSPACE')).toBe(workspaceId);

    // session-B FOLLOWS session-A (created second, chains to the prior session); session-A
    // was first and has no FOLLOWS edge at all; interleaving the repeat calls did not
    // invert the chain or link session-A back to session-B.
    expect(await countFollowsEdges('session-B', 'session-A')).toBe(1);
    expect(await outgoingFollowsCount('session-A')).toBe(0);
    expect(await outgoingFollowsCount('session-B')).toBe(1);
  });

  it('resolves a known identity from the manager cache without writing again', async () => {
    const manager = new SessionManager(harness.driver, { memberId, workspaceId });
    const first = await manager.ensureSession({ identity: 'session-cache', now: new Date('2026-02-01T00:00:00.000Z') });
    expect(first.created).toBe(true);

    const repeats = await Promise.all([
      manager.ensureSession({ identity: 'session-cache' }),
      manager.ensureSession({ identity: 'session-cache' }),
      manager.ensureSession({ identity: 'session-cache' }),
    ]);
    for (const repeat of repeats) {
      expect(repeat).toEqual({ sessionId: 'session-cache', created: false });
    }
  });

  it('collapses concurrent first calls for a brand-new identity into a single session', async () => {
    const manager = new SessionManager(harness.driver, { memberId, workspaceId });

    // All three share the one in-flight write, so all three resolve to the same result
    // (including `created: true`, since the identity genuinely is new) — the thing this
    // proves is that only one Session node lands in the graph, not that only one caller
    // observes `created`.
    const [first, second, third] = await Promise.all([
      manager.ensureSession({ identity: 'session-concurrent' }),
      manager.ensureSession({ identity: 'session-concurrent' }),
      manager.ensureSession({ identity: 'session-concurrent' }),
    ]);

    expect(first).toEqual({ sessionId: 'session-concurrent', created: true });
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    const rows = await runRead(
      harness.driver,
      'MATCH (n:Session { id: $id }) RETURN count(n) AS c',
      { id: 'session-concurrent' },
      (row) => row.c as number,
    );
    expect(rows[0]).toBe(1);
  });

  it('rejects an empty identity', async () => {
    const manager = new SessionManager(harness.driver, { memberId, workspaceId });
    await expect(manager.ensureSession({ identity: '' })).rejects.toThrow(/non-empty/);
  });
});
