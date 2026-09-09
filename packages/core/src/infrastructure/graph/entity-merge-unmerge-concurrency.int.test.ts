import { afterAll, beforeAll, expect, it } from 'vitest';

import { MERGE_PROVENANCE_PROPERTY, redirectAndAbsorb } from './entity-merge-queries.js';
import { readManagedWriteObservations } from './managed-write-observations.js';
import {
  errorChain,
  mentionsDeadlock,
  mergeFamily,
  overlappingMergeInput,
  mergeInput,
  seedEntity,
  startFamilyProbe,
  stopFamilyProbe,
  wasSplitOut,
  type FamilyProbe,
  type UnmergeFamily,
} from './test-support/entity-unmerge-family.fixture.js';
import { nodeProperties } from './test-support/graph-queries.fixture.js';
import { applyUnmerge } from './unmerge-queries.js';

/**
 * The two shipped Entity writers run against each other on one family: `applyUnmerge` splitting
 * an absorbed identity back out while `redirectAndAbsorb` takes the same two ids, with the
 * one-at-a-time arm beside it as the control.
 *
 * The overlap is the merge a caller decided off an older snapshot: the group still names the
 * node the unmerge is splitting, so both writers ask for the same two nodes, and the currency
 * check that will refuse the merge runs after its locks. That is the pair whose acquisition
 * order was mismatched; the order itself is settled in `entity-unmerge-lock-order.int.test.ts`
 * and this file is the workload arm.
 *
 * Both writers run on the watched driver, and every arm reads what their transactions raised
 * rather than only what they answered. `inWriteTransaction` runs on `session.executeWrite`,
 * which replays a deadlock instead of reporting it, and production keeps that retry: a cycle
 * there costs repeated work and latency, and the caller is told nothing.
 *
 * Rates measured here describe this workload on the machine that ran it.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-01T00:05:00.000Z');
const ATTEMPTS = Number(process.env.AION_UNMERGE_CONCURRENT_ATTEMPTS ?? '16');

let probe: FamilyProbe;

beforeAll(async () => {
  probe = await startFamilyProbe('aion-unmerge-concurrency-');
}, 300_000);

afterAll(async () => {
  await stopFamilyProbe(probe);
});

type Failure = { readonly attempt: number; readonly deadlock: boolean; readonly chain: string };

function failureOf(attempt: number, reason: unknown): Failure {
  return { attempt, deadlock: mentionsDeadlock(reason), chain: errorChain(reason) };
}

/**
 * Families built ahead of the arm that uses them, so the seeding round trips never sit between
 * the two writers this file is trying to overlap. `zz-` canonical over an `aa-` absorbed node
 * is the arrangement whose sorted order is the opposite of the order the unmerge pair used to
 * be written in.
 */
async function families(slug: string): Promise<readonly UnmergeFamily[]> {
  const built: UnmergeFamily[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    built.push(
      await mergeFamily(probe, {
        canonicalId: `zz-canon-${slug}-${String(attempt)}`,
        mergedId: `aa-dup-${slug}-${String(attempt)}`,
        now: NOW,
      }),
    );
  }
  return built;
}

function unmerge(family: UnmergeFamily): Promise<unknown> {
  return applyUnmerge(probe.watched, {
    canonicalId: family.canonicalId,
    record: family.record,
    now: LATER,
  });
}

function staleMerge(family: UnmergeFamily): Promise<unknown> {
  return redirectAndAbsorb(probe.watched, overlappingMergeInput(family, LATER));
}

/** The record list the canonical carries, as the merge and the unmerge both rewrite it whole. */
async function storedRecords(canonicalId: string): Promise<Record<string, unknown>[]> {
  const properties = await nodeProperties(probe.driver, canonicalId);
  const stored = (properties[MERGE_PROVENANCE_PROPERTY] ?? []) as string[];
  return stored.map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

function wasSplit(family: UnmergeFamily): Promise<boolean> {
  return wasSplitOut(probe, family);
}

it('control: one writer at a time never fails', async () => {
  const mark = probe.failures.length;
  const failures: Failure[] = [];
  const built = await families('seq');
  for (const [attempt, family] of built.entries()) {
    try {
      await unmerge(family);
      await staleMerge(family);
    } catch (err) {
      failures.push(failureOf(attempt, err));
    }
  }

  expect(probe.failures.slice(mark)).toEqual([]);
  expect(failures).toEqual([]);
  for (const family of built) {
    expect(await wasSplit(family)).toBe(true);
  }
}, 900_000);

/**
 * Every pair fired at once rather than one pair per round: the window in which one writer holds
 * its first lock and has not yet asked for its second is a single round trip wide, so the arm
 * opens as many of them at the same time as it can.
 *
 * The durability expectation is what a cycle would be read for: an unmerge that failed must
 * have left the family exactly as it was. It is vacuous while the arm is clean, and it is the
 * durability statement when it is not.
 */
it('a whole merge and a whole unmerge over one family, at once', async () => {
  const mark = probe.failures.length;
  const built = await families('pair');
  const failures: Failure[] = [];
  const settled = await Promise.allSettled(
    built.flatMap((family) => [unmerge(family), staleMerge(family)]),
  );
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      failures.push(failureOf(Math.floor(index / 2), outcome.reason));
    }
  }

  const unmergeFailures = new Set(
    settled.flatMap((outcome, index) =>
      outcome.status === 'rejected' && index % 2 === 0 ? [Math.floor(index / 2)] : [],
    ),
  );
  for (const [attempt, family] of built.entries()) {
    expect(await wasSplit(family)).toBe(!unmergeFailures.has(attempt));
  }

  expect(probe.failures.slice(mark).filter((chain) => /deadlock/i.test(chain))).toEqual([]);
  expect(failures.filter((failure) => failure.deadlock)).toEqual([]);
  expect(failures).toEqual([]);
}, 900_000);

/**
 * The other overlap on one family: a merge that does apply, absorbing a live duplicate into the
 * canonical while an unmerge splits an older one back out of it. Both writers rewrite the
 * canonical's record list whole from a read of their own, so a write that landed outside the
 * other's lock would drop one of the two records. Only the canonical is shared here, which is
 * why it is a lost-update check rather than a second cycle.
 */
it('keeps both records when a merge and an unmerge write the same canonical at once', async () => {
  const mark = probe.failures.length;
  const family = await mergeFamily(probe, {
    canonicalId: 'zz-canon-live',
    mergedId: 'aa-dup-live',
    now: NOW,
  });
  const liveId = 'mm-dup-live';
  await seedEntity(probe.driver, liveId, NOW);

  const settled = await Promise.allSettled([
    unmerge(family),
    redirectAndAbsorb(probe.watched, mergeInput(family.canonicalId, liveId, LATER)),
  ]);
  const rejected = settled.flatMap((outcome) =>
    outcome.status === 'rejected' ? [errorChain(outcome.reason)] : [],
  );

  expect(probe.failures.slice(mark)).toEqual([]);
  expect(rejected).toEqual([]);
  const records = await storedRecords(family.canonicalId);
  const split = records.find((record) => record.merged_id === family.mergedId);
  const absorbed = records.find((record) => record.merged_id === liveId);
  expect(split?.unmerged_at).toEqual(LATER.toISOString());
  expect(absorbed).toBeDefined();
  expect(absorbed?.unmerged_at).toBeUndefined();
  expect(await wasSplit(family)).toBe(true);
}, 300_000);

/**
 * The counter reads over every arm above, and it is read against the watched driver's own
 * record: the failures the proxy saw inside a transaction body and the failures the counter
 * counted are the same population, so a disagreement means one of the two missed a cycle.
 * A deadlock-free arm is what the corrected acquisition order claims, and this is where that
 * claim is a count rather than an inference from what the callers answered. Seeding runs on
 * the unwatched driver, which is a separate accumulation, so nothing here counts it.
 */
it('counts the callbacks the watched writers ran, and agrees with what their bodies raised', () => {
  const observed = readManagedWriteObservations(probe.watched);

  expect(observed.logicalOperations).toBeGreaterThan(0);
  expect(observed.callerFulfilments + observed.callerRejections).toBe(observed.logicalOperations);
  expect(observed.callbackFailures).toBe(probe.failures.length);
  expect(observed.replaysByClass.deadlock).toBe(0);
  expect(observed.observerFailures).toBe(0);
  console.log(
    `MANAGED WRITE operations=${observed.logicalOperations} attempts=${observed.callbackAttempts} ` +
      `replays=${observed.callbackReplays} deadlock=${observed.replaysByClass.deadlock} ` +
      `other_transient=${observed.replaysByClass.other_transient} ` +
      `outside_callback=${observed.replaysByClass.outside_callback} ` +
      `failures=${observed.callbackFailures} codes=${JSON.stringify(observed.failuresByCode)}`,
  );
});
