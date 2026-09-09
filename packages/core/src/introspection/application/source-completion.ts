import type { CoverageRefusal } from '@aion/protocol';

import { eligibilityAt } from '../../evidence/application/sources.js';
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
 * The evidence half, for the sources a page is about to disclose. It asks C4's own eligibility
 * helper rather than a second reading of the state chain, so a statement accepted while the
 * page was being built withholds its source here exactly as it would on the next request.
 */
export function stillDisclosable(
  db: SqliteHandle,
  sourceId: string,
  context: CheckedReadContext,
): boolean {
  return eligibilityAt(db, sourceId, context).status === 'disclosable';
}
