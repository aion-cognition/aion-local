import { expect, it } from 'vitest';

import {
  disarmPreconditions,
  EVICTION_COMPATIBILITY_REVISION,
  evictionArmingOperationId,
  evictionArmingPublication,
} from './eviction-arming.js';
import { durableEligibility } from './eviction-eligibility.js';
import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
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
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { readCoverageState } from '../../recall/application/coverage-state.js';

/**
 * Arming, through the coordinator that owns it, on a substrate that is not otherwise armed.
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

async function act(kind: 'arm' | 'disarm', operationId: string) {
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

it('arms the fence once, and refuses a later attempt that finds it already armed', async () => {
  await activateCoverage();

  const armed = await arm(
    evictionArmingOperationId('arm', EVICTION_COMPATIBILITY_REVISION, epoch(), NOW),
  );
  expect(armed).toMatchObject({ status: 'acknowledged' });
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
  expect(readCoverageState(store.db)).toMatchObject({
    evictionGate: 'armed',
    evictionCompatibilityRevision: EVICTION_COMPATIBILITY_REVISION,
  });

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
