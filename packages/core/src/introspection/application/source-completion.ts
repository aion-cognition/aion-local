import type { CoverageRefusal } from '@aion/protocol';

import { eligibilityAt } from '../../evidence/application/source-gate.js';
import { idAddress } from '../../evidence/domain/address.js';
import type { EvidenceIssue } from '../../evidence/domain/result.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  coverageRefusal,
  readCoverageStanding,
  type CheckedReadContext,
} from '../../recall/application/coverage-checker.js';

/**
 * What has to be true again at the end of a read that spent time in the middle of it.
 *
 * A page is assembled over many subreads, and the substrate does not hold still for them. The
 * contract can be activated, revised, or become unreadable; a source can be forgotten between
 * the moment a hit was resolved and the moment it would be disclosed. Checking once at the
 * start answers for the first subread and for nothing after it, so both halves are asked again
 * here, and the answer a caller receives is the one that is still true when they receive it.
 */

export type CompletionRefusal = {
  readonly refusal: CoverageRefusal;
};

export type RequestedTimes = {
  readonly asOf?: string;
  readonly knewAt?: string;
};

/**
 * The coverage half. A registry that cannot be read is not an epoch change: nothing about the
 * substrate's reach is known at that moment, the bounds are empty, and telling a caller the
 * contract merely moved would send them to retry against a record nobody can read.
 *
 * When the epoch did move, the bounds reported are the ones just verified, not the ones the
 * read began under. A refusal that quotes a superseded horizon is a claim about coverage the
 * substrate no longer makes.
 */
export function coverageMoved(
  db: SqliteHandle,
  context: CheckedReadContext,
  requested: RequestedTimes,
  now: Date,
): CompletionRefusal | undefined {
  const standing = readCoverageStanding(db);
  const times = {
    ...(requested.asOf === undefined ? {} : { asOf: new Date(requested.asOf) }),
    ...(requested.knewAt === undefined ? {} : { knewAt: new Date(requested.knewAt) }),
    now,
  };
  if (standing === undefined) {
    return { refusal: coverageRefusal('coverage_store_unavailable', times, {}) };
  }
  if (standing.epoch === context.coverageEpoch) {
    return undefined;
  }
  return {
    refusal: coverageRefusal('coverage_changed', times, {
      coverageState: standing.coverageState,
      ...(standing.historySince === undefined ? {} : { historySince: standing.historySince }),
    }),
  };
}

/**
 * The evidence half, for the sources a page is about to disclose.
 *
 * C4 answers three ways and all three survive the crossing. Proved suppression is the substrate
 * answering, so it withholds and claims no history failure. An unproved eligibility is not an
 * answer at all: nobody counted the statements up to the requested vantage, and reporting that
 * silence as a clean absence tells a caller the substrate looked and found nothing. A proof
 * store that cannot be read is a third thing again, repaired by retrying rather than by
 * backfilling a census.
 *
 * Collapsing them to a boolean is what made all three read as absence. The issue each carries
 * is the resolver's own, in its own vocabulary, so the statement a caller receives says the
 * same thing here as it would have said had the census been unknown when the read began.
 */
export type CompletionEligibility =
  | { readonly status: 'disclosable' }
  /** Proved withheld at this vantage. An answer, so it lowers no coverage. */
  | { readonly status: 'suppressed' }
  /** Nobody counted far enough back to say. Carries the signed uncertainty reason. */
  | { readonly status: 'unproved'; readonly issue: EvidenceIssue }
  /** The chain could not be read at all, which retrying repairs. */
  | { readonly status: 'unavailable'; readonly issue: EvidenceIssue };

export function completionEligibility(
  db: SqliteHandle,
  sourceId: string,
  context: CheckedReadContext,
): CompletionEligibility {
  const address = idAddress(sourceId);
  let eligibility;
  try {
    eligibility = eligibilityAt(db, sourceId, context);
  } catch {
    return {
      status: 'unavailable',
      issue: { address, field: 'eligibility', reason: 'store_unavailable', required: true },
    };
  }
  if (eligibility.status === 'disclosable' || eligibility.status === 'suppressed') {
    return { status: eligibility.status };
  }
  return {
    status: 'unproved',
    // The same shape C4 emits from its own unproved branch: an eligibility field, a proved
    // cause, and nothing invented about why the record is silent.
    issue: {
      address,
      field: 'eligibility',
      reason: 'unsupported_history',
      historyReason: 'not_recorded',
      required: true,
    },
  };
}
