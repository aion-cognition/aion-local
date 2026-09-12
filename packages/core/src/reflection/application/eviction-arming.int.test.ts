import { expect, it } from 'vitest';

import { armEvictionOnStart } from './eviction-arming-start.js';
import {
  armingPreconditions,
  disarmPreconditions,
  EVICTION_COMPATIBILITY_REVISION,
  evictionArmingOperationId,
  evictionArmingPublication,
} from './eviction-arming.js';
import { durableEligibility } from './eviction-eligibility.js';
import {
  INSTALLED_PUBLICATION_HANDLERS,
  INSTALLED_PUBLICATION_KINDS,
} from './installed-publications.js';
import {
  acceptSource,
  activateCoverage,
  driver,
  NOW,
  publications,
  store,
} from './test-support/t10b-review.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  claimEvictionStop,
  readSubstratePairing,
} from '../../infrastructure/sqlite/publication-control.js';
import { readCoverageState } from '../../recall/application/coverage-state.js';

/**
 * Arming, through the coordinator that owns it, on a substrate that is not otherwise armed.
 *
 * The arm is the service start's act (`armEvictionOnStart`) rather than a command's, so these
 * cases publish it the way boot does; the stop is still an operator's and is published directly.
 *
 * Order matters in this file. The refusals run first, against a substrate whose coverage contract
 * is still preparing, and the arming act runs last, because arming is not reversible from inside
 * the substrate: the column only moves upward, so a case that armed early would leave every case
 * after it testing a different substrate than the one it names.
 */

const logger = { warn: () => undefined, error: () => undefined };

function epoch(): string {
  return readCurrentCoverageContract(store.db)?.epoch ?? '';
}

function armedRevision(): number {
  return readSubstratePairing(store.db)?.evictionCompatibilityRevision ?? 0;
}

function disarmedAt(): string | null {
  return readSubstratePairing(store.db)?.evictionDisarmedAt ?? null;
}

async function act(kind: 'arm' | 'disarm' | 'rearm', operationId: string) {
  return await publications.publish({
    kind: evictionArmingPublication.kind,
    operationId,
    payload: {
      act: kind,
      revision: EVICTION_COMPATIBILITY_REVISION,
      coverageEpoch: epoch(),
      observedAt: NOW.toISOString(),
    },
  });
}

async function arm(operationId: string) {
  return await act('arm', operationId);
}

it('refuses while the coverage contract has not been activated', async () => {
  expect(readCoverageState(store.db).evictionGate).toBe('unarmed');

  expect(await arm('arming:before-coverage')).toMatchObject({
    status: 'deferred',
    reason: 'coverage_capability_not_established',
  });
  expect(armedRevision()).toBe(0);
});

it('leaves the fence shut at a start whose preconditions do not hold, and names the one that failed', async () => {
  // A boot on a substrate that has not activated coverage yet. The substrate serves; the fence
  // stays shut with the refusal readable, and the next start asks again.
  expect(await armEvictionOnStart(publications, store.db)).toEqual({
    state: 'unarmed',
    reason: 'coverage_capability_not_established',
  });
  expect(armedRevision()).toBe(0);
  expect(readCoverageState(store.db).evictionGate).toBe('unarmed');
});

it('refuses a composition that did not install every declared kind', async () => {
  // The kinds come from the coordinator's own map, so a caller cannot state a set it does not
  // have. A process that composed a smaller one cannot recover a pending operation of a kind it
  // does not know, and that is the condition arming a destructive capability has to rule out.
  const partial = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    now: () => NOW,
    handlers: INSTALLED_PUBLICATION_HANDLERS.filter(
      (handler) => handler.kind !== 'episode_eviction',
    ),
  });
  await partial.initialize();

  expect(
    await partial.publish({
      kind: evictionArmingPublication.kind,
      operationId: 'arming:partial-composition',
      payload: {
        act: 'arm',
        revision: EVICTION_COMPATIBILITY_REVISION,
        coverageEpoch: epoch(),
        observedAt: NOW.toISOString(),
      },
    }),
  ).toMatchObject({ status: 'deferred', reason: 'writer_audit_incomplete' });
  expect(armedRevision()).toBe(0);
});

it('arms the fence at start once coverage is active, and reads it back on the next start', async () => {
  await activateCoverage();

  expect(await armEvictionOnStart(publications, store.db)).toEqual({
    state: 'armed',
    revision: EVICTION_COMPATIBILITY_REVISION,
  });
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
  expect(readCoverageState(store.db).evictionGate).toBe('armed');

  // The second start. Nothing to do, nothing published, and the same answer.
  expect(await armEvictionOnStart(publications, store.db)).toEqual({
    state: 'armed',
    revision: EVICTION_COMPATIBILITY_REVISION,
  });
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
});

it('refuses a later attempt that finds it already armed', async () => {
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
  // A second act under its own identity, which is what a re-arm after a coverage change would
  // take. The fence is where it is, so there is nothing for it to do.
  expect(await arm('arming:again')).toMatchObject({
    status: 'deferred',
    reason: 'already_armed',
  });
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
});

it('stops eviction with a stamp of its own, leaving the revision where it stands', async () => {
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
  const source = await acceptSource('arming:disarm-subject', 'a source to leave alone');

  const stopped = await act(
    'disarm',
    evictionArmingOperationId('disarm', EVICTION_COMPATIBILITY_REVISION, epoch(), NOW),
  );

  expect(stopped).toMatchObject({ status: 'acknowledged' });
  // The revision is not lowered. What this substrate established stays readable, and the stop is
  // a separate fact beside it.
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
  expect(disarmedAt()).not.toBeNull();
  expect(readCoverageState(store.db)).toMatchObject({
    evictionGate: 'disarmed',
    evictionCompatibilityRevision: EVICTION_COMPATIBILITY_REVISION,
  });
  // The stamp beats the revision, so eligibility refuses on it rather than on the number.
  expect(durableEligibility(store.db, source, { now: NOW, minAgeMs: 0 })).toMatchObject({
    status: 'pinned',
    reason: 'compatibility_disarmed',
  });
});

it('does not re-arm a stopped substrate at the next start', async () => {
  // The whole point of keeping `disarm` an operator's command once arming became automatic: a
  // restart is not a retraction. The stop stands and the start says which of the two it found.
  expect(disarmedAt()).not.toBeNull();

  expect(await armEvictionOnStart(publications, store.db)).toMatchObject({ state: 'disarmed' });
  expect(readCoverageState(store.db).evictionGate).toBe('disarmed');
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
});

it('refuses a second stop, and lets a deliberate re-arm clear the one that stands', async () => {
  expect(disarmedAt()).not.toBeNull();

  expect(await act('disarm', 'arming:disarm-again')).toMatchObject({
    status: 'deferred',
    reason: 'already_disarmed',
  });

  // Re-arming at the same revision is allowed precisely because the stop is what is being
  // reversed. Refusing it as `already_armed` would leave a stopped substrate with no way back.
  expect(await arm('arming:re-arm')).toMatchObject({ status: 'acknowledged' });
  expect(disarmedAt()).toBeNull();
  expect(readCoverageState(store.db).evictionGate).toBe('armed');
});

it('refuses a stop on a substrate nobody ever armed', async () => {
  const store2 = new SqliteStore({ filePath: ':memory:' });
  try {
    expect(disarmPreconditions(store2.db).map((check) => check.reason)).toContain('not_armed');
  } finally {
    store2.close();
  }
});

it('stamps the stop with the acknowledgment clock, which is the clock every surface reports', async () => {
  // One act, one moment. The payload carries when the operator asked; the record and the printout
  // both have to carry when the substrate stopped, or an incident timeline built from the command
  // output will not match the substrate it was built from.
  expect(disarmedAt()).toBeNull();

  const stopped = await act('disarm', 'arming:clock');

  expect(stopped.status).toBe('acknowledged');
  if (stopped.status !== 'acknowledged') {
    return;
  }
  expect(disarmedAt()).toBe(stopped.knownFrom);
  expect(readCoverageState(store.db).evictionDisarmedAt).toBe(stopped.knownFrom);
  await arm('arming:clock-restore');
});

it('refuses arming while a stop is owed and nobody has recorded it', async () => {
  // A claim standing with no operation behind it: what a crashed disarm leaves. Arming must not
  // clear it silently, because clearing it loses the record that somebody asked to stop.
  claimEvictionStop(store.db, 'arming:owed-by-nobody');
  try {
    const owed = armingPreconditions(
      store.db,
      INSTALLED_PUBLICATION_KINDS,
      EVICTION_COMPATIBILITY_REVISION,
    ).find((check) => !check.holds);
    expect(owed?.reason).toBe('eviction_stop_owed');
    expect(readCoverageState(store.db)).toMatchObject({
      evictionGate: 'disarmed',
      evictionStopRequestedBy: 'arming:owed-by-nobody',
    });

    // And the next disarm adopts it rather than no-opping beside it, which is what lets its own
    // acknowledgment record the stop and clear the row.
    const stopped = await act('disarm', 'arming:adopts-the-owed');
    expect(stopped.status).toBe('acknowledged');
    expect(readSubstratePairing(store.db)?.evictionStopRequestedBy).toBeNull();
    expect(disarmedAt()).not.toBeNull();
  } finally {
    await arm('arming:owed-restore');
  }
});

/**
 * The stop, the restart that does not lift it, and the operator who does. Last in the file because
 * each case here disarms the substrate the ones above left armed, and puts it back.
 */
it('lets an operator lift a recorded stop, and the next start then keeps it armed', async () => {
  await act('disarm', 'arming:stop-to-lift');
  expect(disarmedAt()).not.toBeNull();
  // A restart is not a retraction: the start finds the stop and leaves it alone.
  expect(await armEvictionOnStart(publications, store.db)).toMatchObject({ state: 'disarmed' });

  const lifted = await act(
    'rearm',
    evictionArmingOperationId('rearm', EVICTION_COMPATIBILITY_REVISION, epoch(), NOW),
  );

  expect(lifted).toMatchObject({ status: 'acknowledged' });
  expect(disarmedAt()).toBeNull();
  expect(readCoverageState(store.db).evictionGate).toBe('armed');
  // And now there is no stop to respect, so the next start reads the fence open and publishes
  // nothing: the lift holds across restarts exactly as the stop did.
  expect(await armEvictionOnStart(publications, store.db)).toEqual({
    state: 'armed',
    revision: EVICTION_COMPATIBILITY_REVISION,
  });
});

it('lifts a stop that was asked for and never recorded, which the start refuses to', async () => {
  // The claim a crashed disarm leaves. The start answers `eviction_stop_owed` and leaves it where
  // it is; the operator's act clears the claim and raises the revision in one transaction. The
  // record of who asked survives in that operation's own intent row, which nothing prunes.
  claimEvictionStop(store.db, 'disarm-that-never-finished');
  expect(await armEvictionOnStart(publications, store.db)).toEqual({
    state: 'unarmed',
    reason: 'eviction_stop_owed',
  });

  expect(await act('rearm', 'arming:lift-the-owed')).toMatchObject({ status: 'acknowledged' });

  expect(readSubstratePairing(store.db)?.evictionStopRequestedBy).toBeNull();
  expect(disarmedAt()).toBeNull();
  expect(readCoverageState(store.db).evictionGate).toBe('armed');
});
