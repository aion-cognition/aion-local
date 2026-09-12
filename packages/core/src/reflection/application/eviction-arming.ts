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
  claimEvictionStop,
  establishEvictionCompatibility,
  evictionStopStands,
  readSubstratePairing,
  recordEvictionDisarm,
  releaseEvictionStopClaim,
} from '../../infrastructure/sqlite/publication-control.js';

/**
 * Arming the destructive capability, and stopping it again.
 *
 * Every substrate is built with eviction fenced rather than absent. `durableEligibility` answers
 * `compatibility_not_established` for every source while the compatibility revision reads zero,
 * and three acts move it: the service arms the fence at start (`eviction-arming-start.ts`), an
 * operator stops it again with `aion evict disarm`, and `aion evict rearm` takes that stop back.
 * Nothing in initialization, the worker or the maintenance catalog reaches any of them.
 *
 * It stays an audited operation now that the arm is automatic, and for the same reason it was one
 * when it was manual. A substrate that can remove memory has to say when it became one, and a
 * decision of that size leaves the same durable record every other decision leaves: one receipt,
 * recoverable if the process dies mid-act, discarded whole if a precondition moved under it.
 *
 * What the check can verify is not the whole of what the fence exists for. The fence was raised
 * because a large body of writers still mutates the graph outside the publication protocol, and
 * no code can look at a substrate and tell whether that body has been converted. So the check
 * takes the conditions that ARE derivable and refuses on any of them, and `ARMING_NOT_VERIFIED`
 * names the rest. `aion evict status` prints both, so the passing checks are never read alone.
 *
 * Stopping goes through the same operation and the same receipt, because a decision to stop
 * removing memory deserves the record a decision to start does. It is not the inverse of arming:
 * the revision is untouched and a separate stamp is written, so the capability this substrate
 * established stays readable and eviction refuses on the stamp before it reads the number. It
 * stops future evictions and it cannot undo one that already happened.
 *
 * And it is not permanent. `rearm` lifts the stamp through the same operation, taking its own
 * receipt, so a stop and the decision to take it back read in sequence rather than as one column
 * that changed its mind.
 */

/** The destructive capability this build implements. A different build carries a different one. */
export const EVICTION_COMPATIBILITY_REVISION = 1;

/**
 * Three acts on one fence, and the third is not the first repeated.
 *
 * `arm` opens the capability and is the service start's. `disarm` stops it and leaves the record
 * that it was open. `rearm` is an operator taking a stop back, and it is its own act because it is
 * the one thing allowed to arm over a stop that was asked for and never recorded: the start must
 * never do that, and a person saying so explicitly is exactly when it is right.
 */
export const EVICTION_ACTS = ['arm', 'disarm', 'rearm'] as const;

export type EvictionAct = (typeof EVICTION_ACTS)[number];

const Payload = z.strictObject({
  act: z.enum(EVICTION_ACTS),
  revision: z.number().int().positive(),
  /** The contract in force when the operator asked, so a coverage change refuses the act. */
  coverageEpoch: z.string().min(1),
  /** When the operator asked. The stop is a stamp, and this is the moment it records. */
  observedAt: z.string().min(1),
});
const Result = z.strictObject({
  act: z.enum(EVICTION_ACTS),
  revision: z.number().int().positive(),
});

/**
 * What arming does NOT verify, in the operator's words.
 *
 * The fence exists because a large body of writers still mutates the graph outside the
 * publication protocol, and no code can look at a substrate and tell whether that work has been
 * done. Everything the check CAN derive is in the table below; everything it cannot is here, and
 * `aion evict status` prints both, because passing checks in a row read as full assurance unless
 * the gaps are printed beside them in the same breath. One export, one renderer: this list is
 * what the automatic arm does not verify, and the surface that reports the fence says so.
 */
export const ARMING_NOT_VERIFIED: readonly string[] = [
  'the writer audit itself: the reflection stage writers, plasticity flush and decay, entity ' +
    'merge and unmerge, proposals, claim consolidation, supersession apply, backbone repair, ' +
    'structural discovery and the registered introspection operations all still write the graph ' +
    'outside the publication protocol. Nothing here checks whether that has been converted',
  'the context-vector runner: survivor repair recomputes a served property outside the guard',
  'the deletion, reclassification and counter-reset constraints: a counted row that can be ' +
    'deleted, replaced, reclassified, retargeted or counter-reset without its qualifications ' +
    'being invalidated makes the tokens eviction compares incomparable, and only a person can ' +
    'say whether a writer added since does that',
  'whether anything on this substrate is worth keeping that eviction would be allowed to remove',
];

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
/** How the fence reads now, in the one place both tables say it. */
function armedDetail(armed: number, disarmed: string | null): string {
  if (disarmed !== null) {
    return `disarmed at ${disarmed}`;
  }
  return armed === 0 ? 'unarmed' : `armed at ${String(armed)}`;
}

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
  const disarmed = pairing?.evictionDisarmedAt ?? null;
  // The same resolver the fence reads, so this table can never disagree with it.
  const owing =
    evictionStopStands(db, pairing) && disarmed === null
      ? (pairing?.evictionStopRequestedBy ?? 'an unnamed operation')
      : undefined;
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
      // A stop asked for and never recorded is not a stop arming may reverse: clearing it would
      // lose the record that somebody asked. Finishing the disarm is the way through, and saying
      // which operation owes it is what makes that actionable.
      name: 'no stop is owed on this substrate',
      reason: 'eviction_stop_owed',
      holds: owing === undefined,
      detail:
        owing === undefined
          ? 'none owed'
          : `a stop is owed by ${owing}: run \`aion evict disarm\` to finish it`,
    },
    {
      // A stopped substrate is re-armable at the same revision: the stop is what is being
      // reversed, and refusing it as `already_armed` would leave no way back. Either stop counts,
      // the recorded stamp and the claim nobody finished, because both are something to lift.
      name: 'the fence is not already at this revision',
      reason: 'already_armed',
      holds: armed < revision || evictionStopStands(db, pairing),
      detail: armedDetail(armed, disarmed),
    },
  ];
}

/**
 * What an explicit re-arm asks, which is the arming table minus one row.
 *
 * `eviction_stop_owed` is there to stop an arming from quietly clearing a stop nobody finished
 * recording, and the service start has to respect it. A person running `aion evict rearm` is the
 * case it was guarding against being taken silently: the act names the stop it lifts, the
 * confirmation says so, and the receipt records who lifted it. The record survives either way,
 * since nothing prunes `publication_intents` and the owed operation's own row stands.
 */
export function rearmPreconditions(
  db: SqliteHandle,
  installedKinds: readonly PublicationKind[],
  revision: number,
): readonly ArmingPrecondition[] {
  return armingPreconditions(db, installedKinds, revision).filter(
    (precondition) => precondition.reason !== 'eviction_stop_owed',
  );
}

/**
 * What stopping asks, which is much less than starting.
 *
 * Disarming is the safe direction. It refuses only what would be a no-op, because a precondition
 * that could block a stop is a precondition that holds a destructive capability open.
 */
export function disarmPreconditions(db: SqliteHandle): readonly ArmingPrecondition[] {
  const pairing = readSubstratePairing(db);
  const armed = pairing?.evictionCompatibilityRevision ?? 0;
  const disarmed = pairing?.evictionDisarmedAt ?? null;
  return [
    {
      name: 'the substrate has a control record to stamp',
      reason: 'substrate_not_initialized',
      holds: pairing !== undefined,
      detail: pairing === undefined ? 'no pairing record' : pairing.bootstrapState,
    },
    {
      name: 'the fence is open',
      reason: 'not_armed',
      holds: armed > 0,
      detail: armed === 0 ? 'never armed' : `armed at ${String(armed)}`,
    },
    {
      name: 'the fence has not already been stopped',
      reason: 'already_disarmed',
      holds: disarmed === null,
      detail: disarmed === null ? 'not disarmed' : `disarmed at ${disarmed}`,
    },
  ];
}

function preconditionsFor(
  context: PublicationContext,
  act: EvictionAct,
  revision: number,
): readonly ArmingPrecondition[] {
  if (act === 'disarm') {
    return disarmPreconditions(context.db);
  }
  if (act === 'rearm') {
    return rearmPreconditions(context.db, context.installedKinds, revision);
  }
  return armingPreconditions(context.db, context.installedKinds, revision);
}

function firstFailure(
  context: PublicationContext,
  act: EvictionAct,
  revision: number,
): string | undefined {
  return preconditionsFor(context, act, revision).find((precondition) => !precondition.holds)
    ?.reason;
}

/**
 * One act, one identity, so a retry lands on the receipt the first attempt took.
 *
 * The moment is in the identity because arming and stopping can each happen more than once on one
 * substrate under one revision and one contract, and each of those is its own decision with its
 * own receipt rather than a replay of the last one.
 */
export function evictionArmingOperationId(
  act: EvictionAct,
  revision: number,
  coverageEpoch: string,
  at: Date,
): string {
  return `eviction-${act}:${String(revision)}:${coverageEpoch}:${at.toISOString()}`;
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
      effects: [
        { kind: 'eviction_control', detail: { act: payload.act, revision: payload.revision } },
      ],
    });
  },
  check(context, data) {
    const failed = firstFailure(context, data.act, data.revision);
    return Promise.resolve(
      failed === undefined
        ? ({ status: 'valid' } as const)
        : ({ status: 'deferred', reason: failed } as const),
    );
  },
  applyGraph(_context, data) {
    // Nothing in the graph changes either way. What this operation writes is a permission, and
    // the graph is what the permission is about.
    return Promise.resolve({ act: data.act, revision: data.revision });
  },
  claimBeforeRecovery(context, payload) {
    if (payload.act !== 'disarm') {
      return undefined;
    }
    // The guard settles whatever is already pending before it takes this request, and settling a
    // pending eviction means re-applying its plan. A stop that first became durable at its own
    // acknowledgment would be recorded on a substrate the removal had already left. So the claim
    // goes down here, under the same lock, before anything is settled.
    claimEvictionStop(context.db, context.operationId);
    return undefined;
  },
  releaseClaim(context, payload) {
    if (payload.act !== 'disarm') {
      return undefined;
    }
    // This request ended without recording a stop, so its name leaves the row with its outcome.
    // Left behind, the resolver reads it as spent and every later disarm's claim is a no-op
    // beside it, which puts the removal back in front of the next stop.
    releaseEvictionStopClaim(context.db, context.operationId);
    return undefined;
  },
  prepareSqlite() {
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    if (data.act === 'disarm') {
      // The acknowledgment clock, which is the one every surface reports and the one the receipt
      // carries. The moment the operator asked is in the payload and is not the moment this
      // substrate stopped.
      recordEvictionDisarm(context.db, context.knownFrom);
      return undefined;
    }
    // Both arming acts land here. The writer clears the stamp and the unfinished claim in the
    // same transaction that raises the revision, which is what keeps a substrate from reading
    // armed by the number and stopped by the stamp; `rearm` is the act allowed to reach it with
    // a claim standing.
    establishEvictionCompatibility(context.db, data.revision);
    return undefined;
  },
  discardSqlite() {
    // Nothing was prepared. A refused act leaves a substrate exactly as fenced as it was.
    return undefined;
  },
});
