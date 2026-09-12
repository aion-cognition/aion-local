import { z } from 'zod';

import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import {
  PUBLICATION_KINDS,
  type PublicationContext,
  type PublicationKind,
} from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  establishEvictionCompatibility,
  readSubstratePairing,
} from '../../infrastructure/sqlite/publication-control.js';

/**
 * Arming the destructive capability: the one act that lets eviction remove anything.
 *
 * Every substrate is built with eviction fenced rather than absent. `durableEligibility` answers
 * `compatibility_not_established` for every source while the compatibility revision reads zero,
 * and nothing in the service, the worker, initialization or the maintenance catalog moves it.
 * The only thing that does is an operator running the command, which publishes this.
 *
 * It is an audited operation because of what it enables. A substrate that can remove memory is a
 * substrate somebody deliberately said could, and a decision of that size has to leave the same
 * durable record every other decision leaves: one receipt, recoverable if the process dies
 * mid-act, discarded whole if a precondition moved under it.
 *
 * What the check can verify is not the whole of what the fence exists for. The fence was raised
 * because a large body of writers still mutates the graph outside the publication protocol, and
 * no code can look at a substrate and tell whether that body has been converted. So the check
 * takes the conditions that ARE derivable and refuses on any of them, and the rest of the
 * judgment stays with whoever types the command.
 */

/** The destructive capability this build implements. A different build carries a different one. */
export const EVICTION_COMPATIBILITY_REVISION = 1;

const Payload = z.strictObject({
  revision: z.number().int().positive(),
  /** The contract in force when the operator asked, so a coverage change refuses the act. */
  coverageEpoch: z.string().min(1),
});
const Result = z.strictObject({ revision: z.number().int().positive() });

export type ArmingPrecondition = {
  readonly name: string;
  /** The refusal the operation answers with, which is also what the command prints. */
  readonly reason: string;
  readonly holds: boolean;
  readonly detail: string;
};

/**
 * Every checkable precondition, evaluated together so a caller can be shown all of them at once
 * rather than one per attempt. The operation refuses on the first that fails; the command prints
 * the whole table, because an operator deciding whether to arm wants the list, not a bisection.
 */
export function armingPreconditions(
  db: SqliteHandle,
  installedKinds: readonly PublicationKind[],
  revision: number,
): readonly ArmingPrecondition[] {
  const installed = new Set(installedKinds);
  const missing = PUBLICATION_KINDS.filter((kind) => !installed.has(kind));
  const pairing = readSubstratePairing(db);
  const contract = readCurrentCoverageContract(db);
  const armed = pairing?.evictionCompatibilityRevision ?? 0;
  return [
    {
      name: 'every declared publication kind has an installed handler',
      reason: 'writer_audit_incomplete',
      holds: missing.length === 0,
      detail:
        missing.length === 0
          ? `all ${String(PUBLICATION_KINDS.length)} kinds are installed`
          : `no handler for ${missing.join(', ')}`,
    },
    {
      name: 'the substrate finished its bootstrap',
      reason: 'substrate_not_initialized',
      holds: pairing?.bootstrapState === 'initialized',
      detail: pairing === undefined ? 'no pairing record' : pairing.bootstrapState,
    },
    {
      name: 'the coverage capability is established',
      reason: 'coverage_capability_not_established',
      holds: (pairing?.activationCapabilityRevision ?? 0) > 0,
      detail: `activation capability revision ${String(pairing?.activationCapabilityRevision ?? 0)}`,
    },
    {
      // A substrate that cannot state what it covers must not be one memory is removed from: a
      // reader would have no way to tell an eviction from a gap the contract never promised.
      name: 'the coverage contract is active',
      reason: 'coverage_contract_not_active',
      holds: contract?.state === 'active',
      detail: contract === undefined ? 'no coverage record' : contract.state,
    },
    {
      name: 'the requested revision is the one this build implements',
      reason: 'arming_revision_not_this_build',
      holds: revision === EVICTION_COMPATIBILITY_REVISION,
      detail: `build implements ${String(EVICTION_COMPATIBILITY_REVISION)}`,
    },
    {
      name: 'the fence is not already at this revision',
      reason: 'already_armed',
      holds: armed < revision,
      detail: armed === 0 ? 'unarmed' : `armed at ${String(armed)}`,
    },
  ];
}

function firstFailure(context: PublicationContext, revision: number): string | undefined {
  return armingPreconditions(context.db, context.installedKinds, revision).find(
    (precondition) => !precondition.holds,
  )?.reason;
}

/** One arming act, one identity, so a retry lands on the receipt the first attempt took. */
export function evictionArmingOperationId(revision: number, coverageEpoch: string): string {
  return `eviction-arming:${String(revision)}:${coverageEpoch}`;
}

export const evictionArmingPublication = new PublicationOperation({
  kind: 'eviction_arming',
  effectKinds: ['eviction_control'],
  payload: Payload,
  data: Payload,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('the eviction fence cannot be armed before the coverage registry exists');
    }
    return Promise.resolve({
      data: payload,
      expected: {
        // The epoch the operator asked under, not the one read here. The coordinator compares it
        // to the contract in force and defers `coverage_epoch_changed`, so an arming request that
        // sat while coverage moved is answered rather than applied to a different contract.
        coverageEpoch: payload.coverageEpoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      scopes: [],
      effects: [{ kind: 'eviction_control', detail: { revision: payload.revision } }],
    });
  },
  check(context, data) {
    const failed = firstFailure(context, data.revision);
    return Promise.resolve(
      failed === undefined
        ? ({ status: 'valid' } as const)
        : ({ status: 'deferred', reason: failed } as const),
    );
  },
  applyGraph(_context, data) {
    // Nothing in the graph changes. What this operation writes is a permission, and the graph is
    // what the permission is about.
    return Promise.resolve({ revision: data.revision });
  },
  prepareSqlite() {
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    establishEvictionCompatibility(context.db, data.revision);
    return undefined;
  },
  discardSqlite() {
    // Nothing was prepared. A refused arming leaves a substrate exactly as fenced as it was.
    return undefined;
  },
});
