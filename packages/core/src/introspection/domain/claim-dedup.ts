/**
 * The pure half of claim-level dedup: which pair a run has already settled, and which of two
 * claims survives a merge. Neither touches the graph, which is what makes both testable
 * without a server.
 */

/** Permanent, keyed on the unordered pair: a pair judged once stays settled whatever it decided. */
export const CLAIM_DEDUP_PAIR_PREFIX = 'claim_dedup.pair:';

export function claimDedupPairKey(a: string, b: string): string {
  return `${CLAIM_DEDUP_PAIR_PREFIX}${[a, b].sort().join(':')}`;
}

export type ClaimDedupNode = {
  readonly id: string;
  readonly occurredAt: Date;
};

export type ClaimDedupSelection = {
  readonly survivor: ClaimDedupNode;
  readonly loser: ClaimDedupNode;
};

/**
 * First assertion wins: the older claim survives, so the merge keeps the text that has already
 * accumulated whatever recall history and reinforcement it earned. A tie on `occurred_at` (two
 * claims extracted from episodes stamped the same instant) breaks on id, so the choice is
 * deterministic rather than dependent on which side of the pair a caller happened to name first.
 */
export function selectClaimDedupSurvivor(
  a: ClaimDedupNode,
  b: ClaimDedupNode,
): ClaimDedupSelection {
  const aOlder =
    a.occurredAt.getTime() === b.occurredAt.getTime() ? a.id <= b.id : a.occurredAt < b.occurredAt;
  return aOlder ? { survivor: a, loser: b } : { survivor: b, loser: a };
}

/**
 * What a judged pair decided, told apart by what a caller does with it rather than by the raw
 * model answers: `merge` is the only outcome that touches the graph, and the three that do not
 * still divide into two kinds the ledger treats differently (see `claim-dedup-judge.ts`'s own
 * doc): a real verdict (`related`, `vetoed`) is ledgered so the pair is never judged again, and
 * `failed` (a call that errored, timed out, or answered in an unusable shape) is not, so a
 * transient failure gets another chance on a later run.
 */
export type ClaimDedupOutcome =
  | { readonly kind: 'merge' }
  | { readonly kind: 'related'; readonly reason: string }
  | { readonly kind: 'vetoed'; readonly reason: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly detail: string };

export function claimDedupLedgered(outcome: ClaimDedupOutcome): boolean {
  return outcome.kind !== 'failed';
}
