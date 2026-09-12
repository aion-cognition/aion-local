import { expect, it } from 'vitest';

import {
  EVICTION_COMPATIBILITY_REVISION,
  evictionArmingOperationId,
  evictionArmingPublication,
} from './eviction-arming.js';
import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import {
  activateCoverage,
  driver,
  NOW,
  publications,
  store,
} from './test-support/t10b-review.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
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

async function arm(operationId: string) {
  return await publications.publish({
    kind: evictionArmingPublication.kind,
    operationId,
    payload: { revision: EVICTION_COMPATIBILITY_REVISION, coverageEpoch: epoch() },
  });
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
      payload: { revision: EVICTION_COMPATIBILITY_REVISION, coverageEpoch: epoch() },
    }),
  ).toMatchObject({ status: 'deferred', reason: 'writer_audit_incomplete' });
  expect(armedRevision()).toBe(0);
});

it('arms the fence once, and refuses a later attempt that finds it already armed', async () => {
  await activateCoverage();

  const armed = await arm(evictionArmingOperationId(EVICTION_COMPATIBILITY_REVISION, epoch()));
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
