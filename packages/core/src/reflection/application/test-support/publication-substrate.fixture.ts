import type { Driver } from 'neo4j-driver';

import { readPublicationGuardBirth } from '../../../infrastructure/graph/publication-guard.js';
import { backdatePublicationGuardBirth } from '../../../infrastructure/graph/test-support/publication-guard.fixture.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { readSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../installed-publications.js';

/**
 * A coordinator a publishing root can actually publish through: installed set, initialized,
 * coverage active.
 *
 * Two things here are easy to get wrong the same way twice, which is why they live in one place.
 *
 * Order first. `initialize` prepares the substrate's first coverage revision itself and refuses
 * a pairing that already carries history, so a record activated before it aborts the bootstrap
 * with `publication_unfinished_pairing_has_history`.
 *
 * Then how coverage is activated. Through the operation that owns it, never by writing the row:
 * activation moves the graph receipt and the epoch together, and a hand-written active record
 * fences every later publication on an epoch no operation stands behind.
 */
export type PublicationSubstrate = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
  /**
   * The coordinator's own clock, where a root needs one it can move.
   *
   * It is not a convenience. Several durable facts are stamped from it and nowhere else — the
   * intake manifest's `created_at`, which is the arrival clock a chunk's span bound is measured
   * from — so a root reasoning about elapsed time on fixture clocks and leaving this at the wall
   * clock is comparing two different axes and will read a negative span.
   */
  readonly now?: () => Date;
};

export async function activatedCoordinator(
  substrate: PublicationSubstrate,
  /** Distinguishes the activation receipt where one process stands up two substrates. */
  label = 'fixture',
): Promise<PublicationCoordinator> {
  const publications = new PublicationCoordinator({
    driver: substrate.driver,
    db: substrate.db,
    logger: substrate.logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    ...(substrate.now === undefined ? {} : { now: substrate.now }),
  });
  await publications.initialize();
  substrate.db.prepare('UPDATE publication_control SET activation_capability_revision = 1').run();
  const outcome = await publications.publish({
    kind: 'coverage_activation',
    operationId: `${label}-coverage-activation`,
    payload: {
      expectedEpoch: readCurrentCoverageContract(substrate.db)?.epoch,
      capabilityRevision: 1,
      fieldPolicyVersion: 1,
    },
  });
  if (outcome.status !== 'acknowledged') {
    throw new Error(`coverage activation ${outcome.status}: ${outcome.reason}`);
  }
  return publications;
}

/**
 * Moves the substrate's birth back to `at`, for a fixture whose history is older than the run.
 *
 * The guard takes the wall clock at initialization whatever clock the coordinator was handed, and
 * the birth fence at intake drops every turn stamped before it. A fixture dated to a fixed day, or
 * a coordinator on a fixed clock, loses its turns at the fence once the run passes that day. This
 * stands the fixture on a substrate that already existed when its history happened.
 *
 * Earlier only: a birth moved forward would fence out turns the substrate already accepted.
 */
export async function backdateSubstrateBirth(
  driver: Driver,
  db: SqliteHandle,
  at: Date,
): Promise<void> {
  const pairing = readSubstratePairing(db);
  const born =
    pairing === undefined
      ? undefined
      : await readPublicationGuardBirth(driver, pairing.substrateId);
  if (pairing === undefined || born === undefined) {
    throw new Error('the substrate has no birth to move: initialize its coordinator first');
  }
  if (at.getTime() > born.getTime()) {
    throw new Error(
      `a birth moves earlier only: ${at.toISOString()} is after ${born.toISOString()}`,
    );
  }
  await backdatePublicationGuardBirth(driver, pairing.substrateId, at);
}
