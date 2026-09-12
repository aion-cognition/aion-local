import type { PublicationCoordinator } from './coordinator.js';
import { readCurrentCoverageContract } from '../sqlite/coverage-contract.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { publicationWrite } from '../sqlite/publication-bounded.js';
import {
  establishActivationCapability,
  readSubstratePairing,
} from '../sqlite/publication-control.js';

/**
 * Lifts a prepared coverage contract to active, which is the step a substrate cannot take for
 * itself.
 *
 * Initialization opens the contract preparing and stops there, and a preparing contract makes no
 * history promise: every temporal read comes back partial with `coverage_contract_not_active`,
 * and no request can be refused as `before_horizon` because there is no horizon to be before.
 * That state is honest and it is also permanent without this step.
 *
 * The boundary it writes is the activation moment and never anything earlier. A substrate that
 * sat preparing while real work accumulated gets a horizon at the moment it activates, so the
 * work behind it is refused as outside the covered window rather than claimed as covered. The
 * alternative would be inventing a moment history started, which a reader cannot tell from a
 * measured one.
 */

/**
 * The coverage capability this build implements and the field policy it activates under. They
 * move together: the activation payload pins the policy, so a build that served a different one
 * would activate under a different capability revision.
 */
const CAPABILITY_REVISION = 1;
const FIELD_POLICY_VERSION = 1;

export type CoverageActivationOutcome =
  | { readonly state: 'active'; readonly historySince: string }
  | { readonly state: 'preparing'; readonly reason: string };

/**
 * Identity derived from the two durable facts the operation's own check reads back. A restart
 * that finds the same contract and the same capability republishes the same operation and gets
 * its recorded outcome; a substrate where either fact has moved is a different decision and
 * takes a different identity, so a refusal recorded against the old pair never stands in for
 * one nobody has taken.
 */
function activationOperationId(epoch: string, capabilityRevision: number): string {
  return `coverage-activation:${epoch}:${String(capabilityRevision)}`;
}

/**
 * Runs at every service start, after the coordinator has initialized. An already active contract
 * returns without publishing: activation is a step the substrate takes once, and republishing it
 * would add a revision and a fresh epoch that every fenced reader would then be out of date
 * against.
 *
 * A refusal is returned rather than thrown. The substrate serves reads against a preparing
 * contract, so an activation the coordinator defers leaves a usable substrate with a named
 * limitation, and the operator surfaces are where that is reported.
 */
export async function activateCoverageOnStart(
  publications: PublicationCoordinator,
  db: SqliteHandle,
): Promise<CoverageActivationOutcome> {
  if (readSubstratePairing(db) === undefined) {
    return { state: 'preparing', reason: 'substrate_pairing_missing' };
  }
  const contract = readCurrentCoverageContract(db);
  if (contract === undefined) {
    return { state: 'preparing', reason: 'coverage_registry_missing' };
  }
  if (contract.state === 'active') {
    return settled(db, 'coverage_contract_unreadable');
  }
  const capabilityRevision = publicationWrite(db, () =>
    establishActivationCapability(db, CAPABILITY_REVISION),
  );
  // A recorded revision ahead of this build is a capability this binary does not implement.
  // Activating against it would claim a contract nothing here knows how to serve, so the older
  // binary leaves the substrate preparing and says why.
  if (capabilityRevision !== CAPABILITY_REVISION) {
    return { state: 'preparing', reason: 'capability_revision_ahead_of_build' };
  }
  const outcome = await publications.publish({
    kind: 'coverage_activation',
    operationId: activationOperationId(contract.epoch, capabilityRevision),
    payload: {
      expectedEpoch: contract.epoch,
      capabilityRevision,
      fieldPolicyVersion: FIELD_POLICY_VERSION,
    },
  });
  if (outcome.status !== 'acknowledged') {
    return { state: 'preparing', reason: outcome.reason };
  }
  return settled(db, 'coverage_activation_incomplete');
}

/** The record as it stands, read back rather than assumed from the outcome that wrote it. */
function settled(db: SqliteHandle, unreadable: string): CoverageActivationOutcome {
  const contract = readCurrentCoverageContract(db);
  if (contract?.state !== 'active' || contract.historySince === null) {
    return { state: 'preparing', reason: unreadable };
  }
  return { state: 'active', historySince: contract.historySince };
}
