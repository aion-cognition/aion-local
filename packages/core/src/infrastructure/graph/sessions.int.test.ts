import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapBackbone } from './backbone.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { runGraphMigrations } from './migrations.js';
import { ensureGraphSession } from './sessions.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

const EMBED_DIMENSION = 8;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let memberId: string;
let workspaceId: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-sessions-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Sessions Test' });
  memberId = backbone.member.id;
  workspaceId = backbone.workspace.id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function countNodes(id: string): Promise<number> {
  const rows = await runRead(
    harness.driver,
    'MATCH (n:Session { id: $id }) RETURN count(n) AS c',
    { id },
    (row) => row.c as number,
  );
  return rows[0] ?? 0;
}

async function countEdges(type: string, sourceId: string, targetId: string): Promise<number> {
  const rows = await runRead(
    harness.driver,
    `MATCH ({ id: $sourceId })-[r:${type}]->({ id: $targetId }) RETURN count(r) AS c`,
    { sourceId, targetId },
    (row) => row.c as number,
  );
  return rows[0] ?? 0;
}

type FollowsEdge = { from: string; to: string };

async function allSessionIds(): Promise<string[]> {
  return runRead(
    harness.driver,
    'MATCH (s:Session) RETURN s.id AS id',
    {},
    (row) => row.id as string,
  );
}

async function allFollowsEdges(): Promise<FollowsEdge[]> {
  return runRead(
    harness.driver,
    'MATCH (a:Session)-[:FOLLOWS]->(b:Session) RETURN a.id AS from, b.id AS to',
    {},
    (row) => ({ from: row.from as string, to: row.to as string }),
  );
}

describe('ensureGraphSession', () => {
  it('creates the Session node with backbone edges and no FOLLOWS for the member’s first session', async () => {
    const result = await ensureGraphSession(harness.driver, {
      sessionId: 'first-session',
      memberId,
      workspaceId,
      now: new Date('2026-03-01T00:00:00.000Z'),
    });

    expect(result).toEqual({ sessionId: 'first-session', created: true, follows: undefined });
    expect(await countNodes('first-session')).toBe(1);
    expect(await countEdges('INITIATED_BY', 'first-session', memberId)).toBe(1);
    expect(await countEdges('WITHIN_WORKSPACE', 'first-session', workspaceId)).toBe(1);
  });

  it('chains a later session to the prior one via FOLLOWS, ordered by write time', async () => {
    const second = await ensureGraphSession(harness.driver, {
      sessionId: 'second-session',
      memberId,
      workspaceId,
      now: new Date('2026-03-01T01:00:00.000Z'),
    });
    expect(second.follows).toBe('first-session');
    expect(await countEdges('FOLLOWS', 'second-session', 'first-session')).toBe(1);

    const third = await ensureGraphSession(harness.driver, {
      sessionId: 'third-session',
      memberId,
      workspaceId,
      now: new Date('2026-03-01T02:00:00.000Z'),
    });
    expect(third.follows).toBe('second-session');
    expect(await countEdges('FOLLOWS', 'third-session', 'second-session')).toBe(1);
    // The chain does not skip a link: third does not point directly at first.
    expect(await countEdges('FOLLOWS', 'third-session', 'first-session')).toBe(0);
  });

  it('is idempotent on a second call for the same identity: no duplicate node, edges, or stamp change', async () => {
    const original = await runRead(
      harness.driver,
      `MATCH (n:Session { id: $id }) RETURN n.${BITEMPORAL_PROPERTIES.txFrom} AS txFrom`,
      { id: 'second-session' },
      (row) => row.txFrom as Date,
    );

    const repeat = await ensureGraphSession(harness.driver, {
      sessionId: 'second-session',
      memberId,
      workspaceId,
      now: new Date('2026-09-09T00:00:00.000Z'),
    });

    expect(repeat.created).toBe(false);
    expect(repeat.follows).toBe('first-session');
    expect(await countNodes('second-session')).toBe(1);
    expect(await countEdges('INITIATED_BY', 'second-session', memberId)).toBe(1);
    expect(await countEdges('WITHIN_WORKSPACE', 'second-session', workspaceId)).toBe(1);
    expect(await countEdges('FOLLOWS', 'second-session', 'first-session')).toBe(1);

    const after = await runRead(
      harness.driver,
      `MATCH (n:Session { id: $id }) RETURN n.${BITEMPORAL_PROPERTIES.txFrom} AS txFrom`,
      { id: 'second-session' },
      (row) => row.txFrom as Date,
    );
    expect(after[0]).toEqual(original[0]);
  });

  // One service handles many agent sessions, each creating its Session node on its first
  // tool call. Unserialized, concurrent first calls cross-link (two sessions pointing at
  // each other) or fork (two sessions claiming the same prior).
  it('keeps the chain a single unbroken path when many identities arrive at once', async () => {
    const identities = Array.from({ length: 8 }, (_, index) => `burst-session-${String(index)}`);

    const results = await Promise.all(
      identities.map((sessionId) =>
        ensureGraphSession(harness.driver, { sessionId, memberId, workspaceId }),
      ),
    );
    expect(results.every((result) => result.created)).toBe(true);

    const sessions = await allSessionIds();
    const edges = await allFollowsEdges();

    expect(sessions).toHaveLength(identities.length + 3);
    expect(edges).toHaveLength(sessions.length - 1);
    // One FOLLOWS out of each linked session, and no two sessions claiming one prior.
    expect(new Set(edges.map((edge) => edge.from)).size).toBe(edges.length);
    expect(new Set(edges.map((edge) => edge.to)).size).toBe(edges.length);

    const next = new Map(edges.map((edge) => [edge.from, edge.to]));
    const followed = new Set(edges.map((edge) => edge.to));
    const heads = sessions.filter((id) => !followed.has(id));
    expect(heads).toEqual([expect.any(String)]);

    // Walking the chain from its newest end reaches every session exactly once, which no
    // cycle and no fork can satisfy. The bound is what keeps a cycle from hanging the test.
    const visited: string[] = [];
    let cursor = heads[0];
    while (cursor !== undefined && visited.length <= sessions.length) {
      visited.push(cursor);
      cursor = next.get(cursor);
    }

    expect(visited).toHaveLength(sessions.length);
    expect(new Set(visited).size).toBe(sessions.length);
    expect(visited[visited.length - 1]).toBe('first-session');
  });
});
