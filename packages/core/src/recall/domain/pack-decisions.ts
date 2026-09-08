import type { PackBucket } from './pack-buckets.js';

/**
 * What assembly decided about one candidate, recorded where the decision is made.
 *
 * The reasons are in the order assembly applies them, and each one is the rule that turned the
 * item away rather than a later guess at which rule it was. A count of folds cannot say which
 * candidate folded or which twin it stood behind, and a set difference over the pack cannot
 * separate a bucket cap from the token budget.
 */

export const PACK_DECISIONS = [
  'accepted',
  /** The same node under the same id, already printed. Identity, not a fold. */
  'already_packed',
  'bucket_cap',
  /** A second item from an episode this pack already prints. */
  'episode_duplicate',
  'token_budget',
  /** Withheld because one of its own twins is already in the pack. */
  'folded',
] as const;

export type PackDecisionReason = (typeof PACK_DECISIONS)[number];

export type PackDecision = {
  readonly id: string;
  readonly bucket: PackBucket;
  readonly reason: PackDecisionReason;
  /** The rank the item took, on the one decision that gives an item a rank. */
  readonly rank?: number;
  /** The twin already in the pack, on a fold. */
  readonly standsInFor?: string;
};

export type PackDecisionObserver = (decision: PackDecision) => void;
