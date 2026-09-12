import { createHash } from 'node:crypto';

import { EVICTION_COMPATIBILITY_REVISION, evictionArmingPublication } from './eviction-arming.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  evictionStopStands,
  readSubstratePairing,
} from '../../infrastructure/sqlite/publication-control.js';

/**
 * Arms the eviction fence at service start, the same shape coverage activation has: a step the
 * substrate takes on its own, once, through the audited operation, with the refusal readable on
 * the operator surfaces when a precondition does not hold.
 *
 * It used to be a command an operator ran. That was the right default while the fence's
 * preconditions were the smaller half of what arming rested on, and the decision to remove the
 * manual step is recorded: Ryan, 2026-09-12. What the fence checks is unchanged, `armingPreconditions`
 * is still the one table, and everything the checks cannot verify is still stated — its home is
 * now `aion evict status`, which is where somebody asking about the fence looks.
 *
 * Two things this deliberately does not do:
 *
 * - It never re-arms a substrate somebody stopped. A disarm is an operator's statement, and a
 *   restart is not a retraction of it, so a standing stamp or an unrecorded stop claim leaves the
 *   fence exactly where the operator left it and says which of the two it found.
 * - It never publishes twice under one set of facts. The identity carries every fact the check
 *   reads and no moment (see `StartArmingFacts`), so a restart that finds the same facts either
 *   reads the fence as already open and returns, or republishes the same operation and gets the
 *   recorded outcome back. A refusal is returned rather than thrown: the substrate serves reads
 *   with the fence shut, which is the state every substrate ships in.
 */

export type EvictionArmingOutcome =
  | { readonly state: 'armed'; readonly revision: number }
  | { readonly state: 'disarmed'; readonly at: string }
  | { readonly state: 'unarmed'; readonly reason: string };

/**
 * Every fact the check reads, which is what the identity is cut from.
 *
 * The coordinator replays a recorded outcome for an identity it has seen and does not re-check it,
 * so an identity narrower than the check turns one refusal into a permanent one. A start under a
 * composition missing a handler would record `writer_audit_incomplete`, and every later start —
 * full composition, same revision, same contract — would replay that refusal for the life of the
 * epoch, with no command left to arm by hand and `aion evict status` printing an all-`[ok]` table
 * beside a closed fence.
 *
 * So a substrate where any of these moved is a different decision and takes a fresh identity, and
 * a repeat under identical facts replays an outcome that is still the right one. This is the
 * coverage activation rule, and its docstring says why: every payload field is in its identity,
 * including the one its own check does not read.
 *
 * Two inputs to the check are deliberately absent. The stop and the armed revision are read before
 * this is built and both return early, so at the point an identity is needed they are constants:
 * no stop stands, and the fence is below the revision.
 */
export type StartArmingFacts = {
  readonly revision: number;
  readonly coverageEpoch: string;
  readonly coverageState: string;
  readonly bootstrapState: string;
  readonly activationCapabilityRevision: number;
  /** The composition that will publish it, from the coordinator rather than the declared list. */
  readonly installedKinds: readonly string[];
};

/**
 * The composition as one short stable token. A digest rather than the list: the identity is a key
 * and the kinds are what moved, so what matters is that two different compositions cannot share
 * one. Sorted first, because a set is what the check reads and registration order is not a fact.
 */
function compositionDigest(installedKinds: readonly string[]): string {
  return createHash('sha256')
    .update([...installedKinds].sort().join(','))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Identity without a moment, which is what makes the start idempotent. The manual acts keep their
 * own timestamped identities: stopping and lifting a stop can each happen more than once on one
 * substrate under one revision and one contract, and each of those is its own decision. Arming
 * under one set of facts is one decision, taken once.
 */
export function evictionArmOnStartOperationId(facts: StartArmingFacts): string {
  return [
    'eviction-arm',
    String(facts.revision),
    facts.coverageEpoch,
    facts.coverageState,
    facts.bootstrapState,
    String(facts.activationCapabilityRevision),
    compositionDigest(facts.installedKinds),
  ].join(':');
}

export async function armEvictionOnStart(
  publications: PublicationCoordinator,
  db: SqliteHandle,
): Promise<EvictionArmingOutcome> {
  const pairing = readSubstratePairing(db);
  if (pairing === undefined) {
    return { state: 'unarmed', reason: 'substrate_pairing_missing' };
  }
  // Before the revision, the way the fence itself reads them: a disarmed substrate is also an
  // armed one, and the stamp is what eviction answers on.
  if (evictionStopStands(db, pairing)) {
    return pairing.evictionDisarmedAt === null
      ? { state: 'unarmed', reason: 'eviction_stop_owed' }
      : { state: 'disarmed', at: pairing.evictionDisarmedAt };
  }
  if (pairing.evictionCompatibilityRevision >= EVICTION_COMPATIBILITY_REVISION) {
    return { state: 'armed', revision: pairing.evictionCompatibilityRevision };
  }
  const contract = readCurrentCoverageContract(db);
  if (contract === undefined) {
    return { state: 'unarmed', reason: 'coverage_registry_missing' };
  }
  const outcome = await publications.publish({
    kind: evictionArmingPublication.kind,
    operationId: evictionArmOnStartOperationId({
      revision: EVICTION_COMPATIBILITY_REVISION,
      coverageEpoch: contract.epoch,
      coverageState: contract.state,
      bootstrapState: pairing.bootstrapState,
      activationCapabilityRevision: pairing.activationCapabilityRevision,
      installedKinds: publications.installedKinds,
    }),
    payload: {
      act: 'arm',
      revision: EVICTION_COMPATIBILITY_REVISION,
      coverageEpoch: contract.epoch,
      // When the act was asked for. Nobody asked: the request is a property of this build and the
      // contract it arms under, so the moment that contract became servable is the honest stamp,
      // and it is the same on every restart, which is what the identity above needs.
      observedAt: contract.activatedAt ?? contract.epoch,
    },
  });
  if (outcome.status !== 'acknowledged') {
    return { state: 'unarmed', reason: outcome.reason };
  }
  // Read back rather than assumed from the outcome that wrote it.
  const armed = readSubstratePairing(db)?.evictionCompatibilityRevision ?? 0;
  return armed >= EVICTION_COMPATIBILITY_REVISION
    ? { state: 'armed', revision: armed }
    : { state: 'unarmed', reason: 'eviction_arming_incomplete' };
}
