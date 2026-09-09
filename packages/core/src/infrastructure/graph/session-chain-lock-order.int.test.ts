import neo4j, { type Driver } from 'neo4j-driver';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { BASE_NODE_LABEL } from './labels.js';
import { LOCK_PROPERTY } from './locks.js';
import {
  publishIntake,
  startIntakeProbe,
  stopIntakeProbe,
  type IntakeProbe,
} from './test-support/session-intake.fixture.js';

/**
 * Which statement reaches a shared node first, settled by holding that node rather than by
 * timing. A transaction of this file's own takes the bare node lock and keeps it; the shipped
 * writer runs beside it and stops; `SHOW TRANSACTIONS` names the statement it stopped on. The
 * holder decides when the wait ends, so the answer is the same on every run.
 *
 * Neo4j takes two locks per node here: `NODE(n)` is the node record and
 * `NODE_RELATIONSHIP_GROUP_DELETE(n)` is the relationship group, which a relationship write
 * acquires by itself, group first. A writer that reaches a node only through an edge write
 * therefore takes them in the opposite order to one that locks the node bare first, and two
 * such writers on one node are a cycle the store breaks by killing a side.
 */

const HOLD_STATEMENT = `MATCH (n:${BASE_NODE_LABEL} { id: $id }) SET n.${LOCK_PROPERTY} = datetime() RETURN n.id AS id`;
const BLOCK_POLL_MS = 20;
/**
 * Under the publication transaction's own five-second deadline, so a writer that never blocks
 * is reported as such instead of dying on a timeout that says nothing about lock order. A block
 * is seen within a poll or two in practice.
 */
const BLOCK_WAIT_MS = 3000;

let probe: IntakeProbe;
/** A driver of its own, so holding and observing are never queued behind the work under test. */
let outside: Driver;

beforeAll(async () => {
  probe = await startIntakeProbe({ prefix: 'aion-lock-order-' });
  outside = neo4j.driver(
    probe.substrate.harness.uri,
    neo4j.auth.basic('neo4j', probe.substrate.harness.password),
  );
}, 300_000);

afterAll(async () => {
  await outside.close();
  await stopIntakeProbe(probe);
});

/** The statement of the one transaction that is waiting, or a failure naming what was seen. */
async function blockedStatement(): Promise<string> {
  const deadline = Date.now() + BLOCK_WAIT_MS;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    const result = await outside.executeQuery(
      `SHOW TRANSACTIONS
       YIELD currentQuery, status
       RETURN currentQuery AS query, status AS status`,
    );
    const rows = result.records
      .map((record) => ({
        query: String(record.get('query') ?? '').replace(/\s+/g, ' '),
        status: String(record.get('status')),
      }))
      .filter((row) => !row.query.startsWith('SHOW TRANSACTIONS'));
    const blocked = rows.find((row) => row.status.startsWith('Blocked'));
    if (blocked !== undefined) {
      return blocked.query;
    }
    seen = rows.map((row) => `${row.status}: ${row.query}`);
    await delay(BLOCK_POLL_MS);
  }
  throw new Error(`nothing blocked within ${String(BLOCK_WAIT_MS)}ms; saw ${seen.join(' | ')}`);
}

/**
 * Holds `nodeId`'s bare node lock, runs `work` beside it, and answers with the statement
 * `work` stopped on. The hold is released as soon as that statement is known, so a writer
 * under a transaction deadline still finishes.
 */
async function statementStoppedBy<T>(
  nodeId: string,
  work: () => Promise<T>,
): Promise<{ readonly query: string; readonly result: T }> {
  const session = outside.session();
  const held = await session.beginTransaction();
  try {
    await held.run(HOLD_STATEMENT, { id: nodeId });
    const running = work();
    let query: string;
    try {
      query = await blockedStatement();
    } finally {
      await held.rollback();
    }
    return { query, result: await running };
  } finally {
    await session.close();
  }
}

it('takes the prior session bare before the FOLLOWS upsert reaches it', async () => {
  const now = new Date();
  await probe.sessions.ensureSession({ identity: 'chain-prior', now, occurredAt: now });

  const observed = await statementStoppedBy('chain-prior', () =>
    probe.sessions.ensureSession({ identity: 'chain-next', now, occurredAt: now }),
  );

  expect(observed.query).toContain(LOCK_PROPERTY);
  expect(observed.query).not.toContain('FOLLOWS');
  expect(observed.result.created).toBe(true);
}, 180_000);

it('reaches the same session node bare on the intake side, before its containment upsert', async () => {
  const occurredAt = new Date();
  const observed = await statementStoppedBy('chain-prior', () =>
    publishIntake(probe, {
      identity: 'chain-prior',
      marker: 'lock-order',
      operationId: 'intake:chain-prior',
      occurredAt,
    }),
  );

  expect(observed.query).toContain(LOCK_PROPERTY);
  expect(observed.query).not.toContain('PARTICIPATES_IN');
  expect(observed.result.status).toBe('acknowledged');
}, 180_000);

/**
 * The Member is reached by the edge that links the session to it, not by the explicit lock
 * further down: that call finds the node already held and reorders nothing. It is the actual
 * order, so it is the one recorded here.
 */
it('reaches the Member through the INITIATED_BY upsert, not through the explicit lock', async () => {
  const now = new Date();
  const observed = await statementStoppedBy(probe.memberId, () =>
    probe.sessions.ensureSession({ identity: 'chain-third', now, occurredAt: now }),
  );

  expect(observed.query).toContain('INITIATED_BY');
  expect(observed.query).not.toContain(LOCK_PROPERTY);
  expect(observed.result.created).toBe(true);
}, 180_000);

/**
 * The mechanism in raw Cypher on nodes this test owns, with no product code in it. Supporting
 * evidence for the three checks above: it says what an inverted order does to any two
 * transactions, and the checks say the shipped ones are not inverted.
 */
it('cycles on an inverted acquisition order and serializes on a matched one', async () => {
  const ids = { shared: 'raw-shared', left: 'raw-left', right: 'raw-right' };
  await outside.executeQuery(
    `UNWIND $ids AS id CREATE (n:${BASE_NODE_LABEL}:Session { id: id, tx_from: datetime() })`,
    { ids: Object.values(ids) },
  );

  const mergeEdge = (type: string): string =>
    `MATCH (a:${BASE_NODE_LABEL} { id: $from }) MATCH (b:${BASE_NODE_LABEL} { id: $to })
     MERGE (a)-[r:${type}]->(b) ON CREATE SET r.id = randomUUID() RETURN r.id AS id`;

  const run = async (
    order: 'node_then_group' | 'group_then_node',
  ): Promise<{ left: string; right: string }> => {
    const leftSession = outside.session();
    const rightSession = outside.session();
    const left = await leftSession.beginTransaction();
    const right = await rightSession.beginTransaction();
    let leftOutcome = 'ok';
    let rightOutcome = 'ok';
    try {
      // The left side is always the projection's order: the bare node lock, then an edge write.
      await left.run(HOLD_STATEMENT, { id: ids.shared });
      const rightWork =
        order === 'group_then_node'
          ? right.run(mergeEdge('FOLLOWS'), { from: ids.right, to: ids.shared })
          : right
              .run(HOLD_STATEMENT, { id: ids.shared })
              .then(() => right.run(mergeEdge('FOLLOWS'), { from: ids.right, to: ids.shared }));
      const settledRight = rightWork.catch((err: unknown) => {
        rightOutcome = err instanceof Error ? err.message : String(err);
      });
      // Long enough for the right side to take whatever it takes first and then stop.
      await delay(400);
      await left
        .run(mergeEdge('PARTICIPATES_IN'), { from: ids.left, to: ids.shared })
        .catch((err: unknown) => {
          leftOutcome = err instanceof Error ? err.message : String(err);
        });
      await left.rollback().catch(() => undefined);
      await settledRight;
      await right.rollback().catch(() => undefined);
    } finally {
      await leftSession.close();
      await rightSession.close();
    }
    return { left: leftOutcome, right: rightOutcome };
  };

  const inverted = await run('group_then_node');
  const matched = await run('node_then_group');

  expect(`${inverted.left}${inverted.right}`).toMatch(/deadlock/i);
  expect(`${matched.left}${matched.right}`).not.toMatch(/deadlock/i);
}, 180_000);
