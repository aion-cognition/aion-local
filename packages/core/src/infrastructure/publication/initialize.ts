import type { Driver } from 'neo4j-driver';

import { PublicationInvariantError, publicationFailure } from './errors.js';
import { verifyPublicationState } from './protocol.js';
import { PUBLICATION_PROTOCOL_VERSION } from './types.js';
import {
  bootstrapPublicationGuard,
  publicationGuardSchemaPresent,
} from '../graph/publication-guard.js';
import { publicationGuardIdentities, readPublicationGuard } from '../graph/publication-receipt.js';
import {
  prepareCoverageContract,
  readCurrentCoverageContract,
} from '../sqlite/coverage-contract.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { publicationWrite } from '../sqlite/publication-bounded.js';
import { readSubstratePairing } from '../sqlite/publication-control.js';
import { assertPendingSlot, coordinatorControl } from '../sqlite/publication-coordinator-store.js';

/** Existing pairs are inspected without writes. Only a verified unfinished bootstrap may create records. */
export async function initializePublication(
  driver: Driver,
  db: SqliteHandle,
  readTimeoutMs: number,
): Promise<void> {
  try {
    await initialize(driver, db, readTimeoutMs);
  } catch (err) {
    throw publicationFailure(err);
  }
}

async function initialize(driver: Driver, db: SqliteHandle, readTimeoutMs: number): Promise<void> {
  const pairing = readSubstratePairing(db);
  const coverage = readCurrentCoverageContract(db);
  if (pairing !== undefined && pairing.protocolVersion !== PUBLICATION_PROTOCOL_VERSION) {
    throw new PublicationInvariantError('publication_protocol_mismatch');
  }
  const identities = await publicationGuardIdentities(driver);
  if (
    identities.length > 1 ||
    (identities.length === 1 && identities[0] !== pairing?.substrateId)
  ) {
    throw new PublicationInvariantError('publication_foreign_graph_pairing');
  }
  if (pairing?.bootstrapState === 'initialized') {
    if (coverage === undefined) {
      throw new PublicationInvariantError('coverage_registry_missing');
    }
    const guard = await readPublicationGuard(driver, pairing.substrateId, readTimeoutMs);
    verifyPublicationState(db, guard);
  } else {
    if (pairing !== undefined) {
      const control = coordinatorControl(db);
      assertPendingSlot(db, control);
      if (
        control.lastAckSequence !== '0' ||
        control.pendingOperationId !== null ||
        control.lastKnownFrom !== null
      ) {
        throw new PublicationInvariantError('publication_unfinished_pairing_has_history');
      }
      if (identities.length === 1) {
        const guard = await readPublicationGuard(driver, pairing.substrateId, readTimeoutMs);
        if (
          guard.protocolVersion !== PUBLICATION_PROTOCOL_VERSION ||
          guard.sequence !== '0' ||
          guard.operationId !== null ||
          guard.intentDigest !== null ||
          guard.resultDigest !== null
        ) {
          throw new PublicationInvariantError('publication_initial_receipt_invalid');
        }
      }
    }
    if (
      db.prepare('SELECT 1 FROM publication_intents LIMIT 1').get() !== undefined ||
      coverage?.state === 'active'
    ) {
      throw new PublicationInvariantError('publication_unfinished_pairing_has_history');
    }
  }
  if (!(await publicationGuardSchemaPresent(driver))) {
    throw new PublicationInvariantError('publication_guard_schema_missing');
  }
  if (pairing?.bootstrapState === 'initialized') {
    return;
  }
  publicationWrite(db, () => prepareCoverageContract(db, 1));
  const initialized = await bootstrapPublicationGuard(driver, db, PUBLICATION_PROTOCOL_VERSION);
  if (initialized.outcome === 'missing') {
    throw new PublicationInvariantError('publication_guard_missing');
  }
  const finalIdentities = await publicationGuardIdentities(driver);
  if (finalIdentities.length !== 1 || finalIdentities[0] !== initialized.substrateId) {
    throw new PublicationInvariantError('publication_foreign_graph_pairing');
  }
  verifyPublicationState(
    db,
    await readPublicationGuard(driver, initialized.substrateId, readTimeoutMs),
  );
}
