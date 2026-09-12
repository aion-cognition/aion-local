import type { Driver } from 'neo4j-driver';

import type { Logger } from '../../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
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
