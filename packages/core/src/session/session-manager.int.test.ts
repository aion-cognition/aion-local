import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapBackbone } from '../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../infrastructure/graph/migrations.js';
import {
  countEdges,
  countNodesWithId,
  countOutgoingEdges,
  edgeTargetId,
} from '../infrastructure/graph/test-support/graph-queries.fixture.js';
import { startNeo4jHarness, stopNeo4jHarness, type Neo4jHarness } from '../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../infrastructure/sqlite/database.js';
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
    expect(await edgeTargetId(harness.driver, 'INITIATED_BY', 'session-A')).toBe(memberId);
    expect(await edgeTargetId(harness.driver, 'WITHIN_WORKSPACE', 'session-A')).toBe(workspaceId);
    expect(await edgeTargetId(harness.driver, 'INITIATED_BY', 'session-B')).toBe(memberId);
    expect(await edgeTargetId(harness.driver, 'WITHIN_WORKSPACE', 'session-B')).toBe(workspaceId);

    // session-B FOLLOWS session-A (created second, chains to the prior session); session-A
    // was first and has no FOLLOWS edge at all; interleaving the repeat calls did not
    // invert the chain or link session-A back to session-B.
    expect(await countEdges(harness.driver, 'FOLLOWS', 'session-B', 'session-A')).toBe(1);
    expect(await countOutgoingEdges(harness.driver, 'FOLLOWS', 'session-A')).toBe(0);
    expect(await countOutgoingEdges(harness.driver, 'FOLLOWS', 'session-B')).toBe(1);
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

    expect(await countNodesWithId(harness.driver, 'Session', 'session-concurrent')).toBe(1);
  });

  it('rejects an empty identity', async () => {
    const manager = new SessionManager(harness.driver, { memberId, workspaceId });
    await expect(manager.ensureSession({ identity: '' })).rejects.toThrow(/non-empty/);
  });
});
