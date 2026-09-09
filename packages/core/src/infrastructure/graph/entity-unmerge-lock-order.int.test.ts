import neo4j, { type Driver } from 'neo4j-driver';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { redirectAndAbsorb } from './entity-merge-queries.js';
import { BASE_NODE_LABEL } from './labels.js';
import { LOCK_PROPERTY } from './locks.js';
import {
  errorChain,
  mergeFamily,
  overlappingMergeInput,
  startFamilyProbe,
  stopFamilyProbe,
  wasSplitOut,
  type FamilyProbe,
  type UnmergeFamily,
} from './test-support/entity-unmerge-family.fixture.js';
import { applyUnmerge } from './unmerge-queries.js';

/**
 * Which of a family's two nodes a writer takes first, settled by holding one of them rather
 * than by timing.
 *
 * Statement text cannot answer it here: both halves of the pair are locked by the same
 * `locked_at` statement, so a writer stopped on the first and a writer stopped on the second
 * look identical in `SHOW TRANSACTIONS`. What separates them is what the stopped writer is
 * already holding. So a transaction of this file's own holds one node, the writer runs beside
 * it and stops, and a second short-lived transaction then asks for the other node: it is
 * refused if the writer took that one first and served if the writer had not reached it. Both
 * holders decide when their waits end, so the answer is the same on every run.
 *
 * Two families, arranged in opposite id orders, are what make this an order check rather than
 * a role check: the writer must follow the sort, not the canonical.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-01T00:05:00.000Z');
const HOLD_STATEMENT = `MATCH (n:${BASE_NODE_LABEL} { id: $id }) SET n.${LOCK_PROPERTY} = datetime() RETURN n.id AS id`;
const BLOCK_POLL_MS = 20;
/** A block shows up within a poll or two; this only bounds a writer that never blocks at all. */
const BLOCK_WAIT_MS = 5000;
/** Long enough that an uncontended one-node write is never mistaken for a refused one. */
const PROBE_TIMEOUT_MS = 1500;
/** Rounds of the forced arm, over a family of their own each. */
const FORCED_ROUNDS = 4;

let probe: FamilyProbe;
/** A driver of its own, so holding and observing are never queued behind the work under test. */
let outside: Driver;

beforeAll(async () => {
  probe = await startFamilyProbe('aion-unmerge-lock-order-');
  outside = neo4j.driver(
    probe.substrate.harness.uri,
    neo4j.auth.basic('neo4j', probe.substrate.harness.password),
  );
}, 300_000);

afterAll(async () => {
  await outside.close();
  await stopFamilyProbe(probe);
});

/** The statements of the transactions that are waiting, or a failure naming what was seen. */
async function blockedStatements(wanted: number): Promise<readonly string[]> {
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
    const blocked = rows.filter((row) => row.status.startsWith('Blocked'));
    if (blocked.length >= wanted) {
      return blocked.map((row) => row.query);
    }
    seen = rows.map((row) => `${row.status}: ${row.query}`);
    await delay(BLOCK_POLL_MS);
  }
  throw new Error(
    `fewer than ${String(wanted)} blocked within ${String(BLOCK_WAIT_MS)}ms; saw ${seen.join(' | ')}`,
  );
}

/** The statement of the one transaction that is waiting. */
async function blockedStatement(): Promise<string> {
  const [first] = await blockedStatements(1);
  return first ?? '';
}

function refusedForLock(err: unknown): boolean {
  const { code } = err as { code?: unknown };
  const text = `${typeof code === 'string' ? code : ''} ${err instanceof Error ? err.message : ''}`;
  return /TransactionTimedOut|Terminated|LockClientStopped/i.test(text);
}

/**
 * Whether the blocked writer is already holding `id`. The probe transaction carries a timeout,
 * so a node the writer holds answers `held` after that wait instead of hanging this file, and
 * a free node answers `served` in the round trip it takes to write it.
 */
async function askFor(id: string): Promise<'served' | 'held'> {
  const session = outside.session();
  const tx = await session.beginTransaction({ timeout: PROBE_TIMEOUT_MS });
  try {
    await tx.run(HOLD_STATEMENT, { id });
    await tx.rollback();
    return 'served';
  } catch (err) {
    if (!refusedForLock(err)) {
      throw err;
    }
    return 'held';
  } finally {
    await tx.rollback().catch(() => undefined);
    await session.close();
  }
}

type Observation = {
  /** The statement the writer stopped on. */
  readonly query: string;
  /** Whether the writer was holding the node it had not been stopped on. */
  readonly other: 'served' | 'held';
};

/**
 * Holds `heldId`, runs `work` beside it, and reports the statement `work` stopped on together
 * with whether it was already holding `otherId`. The hold is released as soon as both are
 * known, so the writer still finishes.
 */
async function observe(
  heldId: string,
  otherId: string,
  work: () => Promise<unknown>,
): Promise<Observation> {
  const session = outside.session();
  const held = await session.beginTransaction();
  try {
    await held.run(HOLD_STATEMENT, { id: heldId });
    const running = work();
    let query: string;
    let other: 'served' | 'held';
    try {
      query = await blockedStatement();
      other = await askFor(otherId);
    } finally {
      await held.rollback();
    }
    await running;
    return { query, other };
  } finally {
    await session.close();
  }
}

function unmerge(family: UnmergeFamily): () => Promise<unknown> {
  return () =>
    applyUnmerge(probe.driver, {
      canonicalId: family.canonicalId,
      record: family.record,
      now: LATER,
    });
}

/**
 * `zz-` canonical, `aa-` absorbed node: the family whose sorted order is the opposite of the
 * order the pair used to be written in. Both directions are checked, because either one alone
 * is also explained by the writer simply blocking on the node this file happens to hold.
 */
it('stops on the family node that sorts first, holding nothing else', async () => {
  const family = await mergeFamily(probe, {
    canonicalId: 'zz-canon-one',
    mergedId: 'aa-dup-one',
    now: NOW,
  });
  expect(family.sortedFirst).toBe(family.mergedId);

  const observed = await observe(family.sortedFirst, family.sortedSecond, unmerge(family));

  expect(observed.query).toContain(LOCK_PROPERTY);
  expect(observed.other).toBe('served');
}, 180_000);

it('holds the family node that sorts first while it waits for the second', async () => {
  const family = await mergeFamily(probe, {
    canonicalId: 'zz-canon-two',
    mergedId: 'aa-dup-two',
    now: NOW,
  });

  const observed = await observe(family.sortedSecond, family.sortedFirst, unmerge(family));

  expect(observed.query).toContain(LOCK_PROPERTY);
  expect(observed.other).toBe('held');
}, 180_000);

/**
 * The same two checks on the arrangement where the canonical sorts first. The old unsorted pair
 * agreed with the sort here, so this family passed before the change too: it is what says the
 * writer follows the ids rather than having swapped one fixed role order for another.
 */
it('follows the sort, not the canonical, when the canonical sorts first', async () => {
  const family = await mergeFamily(probe, {
    canonicalId: 'aa-canon-three',
    mergedId: 'zz-dup-three',
    now: NOW,
  });
  expect(family.sortedFirst).toBe(family.canonicalId);

  const observed = await observe(family.sortedFirst, family.sortedSecond, unmerge(family));

  expect(observed.query).toContain(LOCK_PROPERTY);
  expect(observed.other).toBe('served');
}, 180_000);

it('waits for the absorbed node while holding the canonical when the canonical sorts first', async () => {
  const family = await mergeFamily(probe, {
    canonicalId: 'aa-canon-four',
    mergedId: 'zz-dup-four',
    now: NOW,
  });

  const observed = await observe(family.sortedSecond, family.sortedFirst, unmerge(family));

  expect(observed.query).toContain(LOCK_PROPERTY);
  expect(observed.other).toBe('held');
}, 180_000);

/**
 * The merge writer, on the arrangement the unmerge used to invert on. It is the order the
 * unmerge now matches, so it is recorded here beside it rather than assumed from the helper it
 * calls. This group is stale by construction, and the currency check that says so runs after
 * these locks.
 */
it('takes the same family through the same sorted order on the merge side', async () => {
  const family = await mergeFamily(probe, {
    canonicalId: 'zz-canon-five',
    mergedId: 'aa-dup-five',
    now: NOW,
  });

  const observed = await observe(family.sortedFirst, family.sortedSecond, () =>
    redirectAndAbsorb(probe.driver, overlappingMergeInput(family, LATER)),
  );

  expect(observed.query).toContain(LOCK_PROPERTY);
  expect(observed.other).toBe('served');
}, 180_000);

/**
 * The node that sorts first, held while both writers queue behind it, with the merge queued
 * first and the unmerge let through to its own wait behind it.
 *
 * The staging is what puts a mismatch one step from a cycle rather than leaving it to chance.
 * Under the matched order both writers ask for this node first and hold nothing while they
 * wait, so the release lets them through one at a time. Under a mismatch the unmerge asked for
 * the other node first and is already holding it when it queues here, so releasing this one
 * either hands it to the merge, which then asks for the node the waiter holds and closes the
 * cycle, or hands it to the unmerge, which goes through. Which of the two the store picks is
 * its own choice, so the arm is rounds.
 */
async function releaseBothTo(family: UnmergeFamily): Promise<readonly string[]> {
  const session = outside.session();
  const held = await session.beginTransaction();
  try {
    await held.run(HOLD_STATEMENT, { id: family.sortedFirst });
    const merging = redirectAndAbsorb(probe.watched, overlappingMergeInput(family, LATER)).then(
      (result) => `merge ${result.status}`,
      (err: unknown) => `merge failed: ${errorChain(err)}`,
    );
    await blockedStatements(1);
    const unmerging = applyUnmerge(probe.watched, {
      canonicalId: family.canonicalId,
      record: family.record,
      now: LATER,
    }).then(
      (result) => `unmerge restored ${result.restoredId}`,
      (err: unknown) => `unmerge failed: ${errorChain(err)}`,
    );
    await blockedStatements(2);
    await held.rollback();
    return await Promise.all([unmerging, merging]);
  } finally {
    await session.close();
  }
}

/**
 * Read off what the transactions raised, not only what the two writers answered: the managed
 * retry replays a victim, so a cycle here would otherwise show up as a slower success.
 */
it('does not cycle when the two family nodes are released to both writers in turn', async () => {
  const mark = probe.failures.length;
  const rounds: { readonly outcomes: readonly string[]; readonly split: boolean }[] = [];
  for (let round = 0; round < FORCED_ROUNDS; round += 1) {
    const family = await mergeFamily(probe, {
      canonicalId: `zz-canon-forced-${String(round)}`,
      mergedId: `aa-dup-forced-${String(round)}`,
      now: NOW,
    });
    const outcomes = await releaseBothTo(family);
    rounds.push({ outcomes, split: await wasSplitOut(probe, family) });
  }
  const answers = rounds.flatMap((round) => round.outcomes);

  // Durable either way, so it is a real statement when a side does die: the identity is back
  // out exactly when the unmerge said so, and a killed one leaves the family as it was.
  expect(rounds.map((round) => round.split)).toEqual(
    rounds.map((round) => round.outcomes[0]?.startsWith('unmerge restored')),
  );

  expect(probe.failures.slice(mark).filter((chain) => /deadlock/i.test(chain))).toEqual([]);
  expect(answers.filter((answer) => /deadlock/i.test(answer))).toEqual([]);
  expect(answers.filter((answer) => answer.includes('failed'))).toEqual([]);
  expect(rounds.map((round) => round.outcomes[1])).toEqual(rounds.map(() => 'merge stale'));
}, 300_000);
