import {
  COVERAGE_CONTRACT_VERSION,
  IsoTimestampSchema,
  type CoverageRefusal,
  type CoverageRefusalReason,
  type HistoryCoverage,
} from '@aion/protocol';

import { readModeFor } from './read-mode.js';
import { isTimeTravel, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import {
  readCurrentCoverageContract,
  type CoverageContractRecord,
} from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * The preserved-field policy this binary implements. A record naming another version describes
 * limits this code does not know how to apply, so it is not a record this reader can serve.
 */
export const COVERAGE_FIELD_POLICY_VERSION = 1;

/**
 * What every covered entry point holds instead of a bare read mode: the interval, the one
 * clock the request was judged against, and the coverage the answer may claim.
 *
 * `coverageEpoch` is an equality fence. A read that finishes under a different epoch finished
 * under a different contract, and reporting its original context as current would be a claim
 * about coverage the substrate no longer makes.
 */
export type CheckedReadContext = {
  readonly mode: ReadMode;
  readonly now: Date;
  readonly coverageEpoch: string;
  readonly contractVersion: 1;
  readonly fieldPolicyVersion: 1;
} & (
  | { readonly coverageState: 'active'; readonly historySince: string }
  | { readonly coverageState: 'preparing' }
);

/** The context and the statement the answer carries, which are produced from one reading. */
export type CheckedRead = {
  readonly context: CheckedReadContext;
  readonly coverage: HistoryCoverage;
};

export type CoverageCheck =
  | ({ readonly status: 'checked' } & CheckedRead)
  | { readonly status: 'refused'; readonly refusal: CoverageRefusal };

export type CoverageRequest = {
  /** World time, as the caller sent it. Rejected by the grammar rather than reinterpreted. */
  readonly asOf?: string;
  /** Knowledge time, as the caller sent it. */
  readonly knewAt?: string;
  /** Pinned once by the entry point, so every comparison in the run uses one clock. */
  readonly now: Date;
  readonly expiryAnnotation: boolean;
};

/**
 * A temporal input outside the protocol's timestamp grammar. This is a usage error rather than
 * a coverage refusal: the substrate has said nothing about its reach yet, and a caller sending
 * an unparseable date has not asked a question the coverage contract can answer.
 */
export class CoverageRequestError extends Error {
  readonly field: 'as_of' | 'knew_at';
  constructor(field: 'as_of' | 'knew_at', value: string) {
    super(`${field} must be an ISO 8601 date or datetime, received ${value}`);
    this.field = field;
    this.name = 'CoverageRequestError';
  }
}

type RequestedTimes = {
  readonly asOf?: Date;
  readonly knewAt?: Date;
};

/** The record in force, once it is one this reader can honestly serve. */
type ServableContract =
  | { readonly state: 'active'; readonly epoch: string; readonly historySince: string }
  | { readonly state: 'preparing'; readonly epoch: string };

/**
 * Date-only inputs land on UTC midnight, which is what the protocol grammar means by a date.
 * A command line that accepted more than this grammar accepted questions the substrate then
 * answered against a different instant than the same text sent over the wire.
 */
function parse(field: 'as_of' | 'knew_at', value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!IsoTimestampSchema.safeParse(value).success) {
    throw new CoverageRequestError(field, value);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CoverageRequestError(field, value);
  }
  return parsed;
}

/**
 * A stored moment, read under the same grammar as a request. A boundary the reader cannot parse
 * is worse than a missing one: comparisons against it silently answer false, so a request before
 * the horizon would be served rather than refused.
 */
function instant(value: string): number | undefined {
  if (!IsoTimestampSchema.safeParse(value).success) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function servable(record: CoverageContractRecord | undefined): ServableContract | undefined {
  if (
    record === undefined ||
    record.epoch === '' ||
    record.contractVersion !== COVERAGE_CONTRACT_VERSION ||
    record.fieldPolicyVersion !== COVERAGE_FIELD_POLICY_VERSION
  ) {
    return undefined;
  }
  if (record.state === 'preparing') {
    return record.historySince === null && record.activatedAt === null
      ? { state: 'preparing', epoch: record.epoch }
      : undefined;
  }
  const { historySince, activatedAt } = record;
  if (historySince === null || activatedAt === null) {
    return undefined;
  }
  const since = instant(historySince);
  const activated = instant(activatedAt);
  // The boundary is the activation moment and stays there: a record whose two moments disagree
  // is one where nobody can say which is the floor. The activation clock may sit later than a
  // reader's own clock, which is the clamp doing its job and not a corrupt record.
  if (since === undefined || activated === undefined || since !== activated) {
    return undefined;
  }
  return { state: 'active', epoch: record.epoch, historySince };
}

/**
 * The record in force, or nothing. A read failure and a missing record answer the same way on
 * purpose: neither one lets a reader say what the substrate covers, and the refusal is where
 * that is disclosed.
 */
function currentContract(db: SqliteHandle): ServableContract | undefined {
  try {
    return servable(readCurrentCoverageContract(db));
  } catch {
    return undefined;
  }
}

/**
 * What the substrate covers right now: the epoch a checked read is fenced on, and the bounds a
 * refusal reports. A reader whose contract moved is told what the contract is now, not what it
 * was when the read began.
 */
export type CoverageStanding = {
  readonly epoch: string;
  readonly coverageState: 'preparing' | 'active';
  readonly historySince?: string;
};

export function readCoverageStanding(db: SqliteHandle): CoverageStanding | undefined {
  const contract = currentContract(db);
  if (contract === undefined) {
    return undefined;
  }
  return contract.state === 'active'
    ? { epoch: contract.epoch, coverageState: 'active', historySince: contract.historySince }
    : { epoch: contract.epoch, coverageState: 'preparing' };
}

/** The epoch in force, for the completion fence. Absent when the record cannot be served. */
export function readCoverageFence(db: SqliteHandle): string | undefined {
  return readCoverageStanding(db)?.epoch;
}

export function coverageRefusal(
  reason: CoverageRefusalReason,
  requested: RequestedTimes & { readonly now: Date },
  bounds: { readonly historySince?: string; readonly coverageState?: 'preparing' | 'active' },
): CoverageRefusal {
  return {
    contract_version: COVERAGE_CONTRACT_VERSION,
    reason,
    requested: {
      ...(requested.asOf === undefined ? {} : { as_of: requested.asOf.toISOString() }),
      ...(requested.knewAt === undefined ? {} : { knew_at: requested.knewAt.toISOString() }),
      now: requested.now.toISOString(),
    },
    bounds: {
      ...(bounds.historySince === undefined ? {} : { history_since: bounds.historySince }),
      ...(bounds.coverageState === undefined ? {} : { coverage_state: bounds.coverageState }),
    },
  };
}

function statement(
  contract: ServableContract,
  times: RequestedTimes,
  temporal: boolean,
): HistoryCoverage {
  const preparing = contract.state === 'preparing';
  return {
    contract_version: COVERAGE_CONTRACT_VERSION,
    ...(contract.state === 'active' ? { history_since: contract.historySince } : {}),
    // A preparing contract makes no history promise, so a request that asks about the past is
    // answered as partial. A present request is not partial for that reason: it asks about now.
    status: preparing && temporal ? 'partial' : 'supported',
    ...(times.asOf === undefined ? {} : { as_of: times.asOf.toISOString() }),
    ...(times.knewAt === undefined ? {} : { knew_at: times.knewAt.toISOString() }),
    limitations: preparing ? ['coverage_contract_not_active'] : [],
    gaps: [],
  };
}

function checkedContext(contract: ServableContract, mode: ReadMode, now: Date): CheckedReadContext {
  const base = {
    mode,
    now,
    coverageEpoch: contract.epoch,
    contractVersion: COVERAGE_CONTRACT_VERSION,
    fieldPolicyVersion: COVERAGE_FIELD_POLICY_VERSION,
  } as const;
  return contract.state === 'active'
    ? { ...base, coverageState: 'active', historySince: contract.historySince }
    : { ...base, coverageState: 'preparing' };
}

/**
 * The one coverage decision, taken before a request spends anything.
 *
 * It parses the temporal inputs under the protocol grammar, reads the coverage record in
 * force, and either hands back a checked context or refuses with the reason, what was asked
 * and the bounds it was judged against. Every covered entry point runs it, present requests
 * included: an unreadable coverage record leaves a reader unable to say what any answer
 * covers, and a substrate whose control record is corrupt is one whose answers are all
 * suspect. Repairing that record is the way back, not a quieter answer.
 *
 * The order matters. A refused request has created no session, deleted no served rows and
 * called no provider, which is the whole reason the check comes first.
 */
export function checkCoverage(db: SqliteHandle, request: CoverageRequest): CoverageCheck {
  const asOf = parse('as_of', request.asOf);
  const knewAt = parse('knew_at', request.knewAt);
  const times: RequestedTimes = {
    ...(asOf === undefined ? {} : { asOf }),
    ...(knewAt === undefined ? {} : { knewAt }),
  };
  const requested = { ...times, now: request.now };
  const contract = currentContract(db);
  if (contract === undefined) {
    return {
      status: 'refused',
      refusal: coverageRefusal('coverage_store_unavailable', requested, {}),
    };
  }
  const bounds = {
    coverageState: contract.state,
    ...(contract.state === 'active' ? { historySince: contract.historySince } : {}),
  };
  // Knowledge past the request clock is knowledge nobody has, which is a different answer from
  // a world time in the future: that one asks what is believed now about a later moment.
  if (knewAt !== undefined && knewAt.getTime() > request.now.getTime()) {
    return { status: 'refused', refusal: coverageRefusal('future_knowledge', requested, bounds) };
  }
  if (
    contract.state === 'active' &&
    knewAt !== undefined &&
    knewAt.getTime() < Date.parse(contract.historySince)
  ) {
    return { status: 'refused', refusal: coverageRefusal('before_horizon', requested, bounds) };
  }
  const mode = readModeFor(
    {
      ...(asOf === undefined ? {} : { as_of: asOf.toISOString() }),
      ...(knewAt === undefined ? {} : { knew_at: knewAt.toISOString() }),
    },
    { now: request.now, expiryAnnotation: request.expiryAnnotation },
  );
  return {
    status: 'checked',
    context: checkedContext(contract, mode, request.now),
    coverage: statement(contract, times, isTimeTravel(mode)),
  };
}

/**
 * The present-vantage checked read, for an entry point that asks no temporal question.
 *
 * Maintenance, the reflection pipeline and the migration all read the durable records the same
 * way a recall does, and they must read them under the same contract: a resolver handed a bare
 * read mode has no epoch to fence on and no coverage statement to attach, so it would answer
 * about a substrate whose contract could have moved underneath it. They ask nothing about the
 * past, so nothing here is a temporal request; the refusal branch is a control record nobody can
 * read, which is a reason for a sweep to stop rather than to guess.
 */
export function checkPresentCoverage(db: SqliteHandle, now: Date): CoverageCheck {
  return checkCoverage(db, { now, expiryAnnotation: false });
}
