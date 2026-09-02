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

/**
 * Permanent, keyed on one node: this node has stood as the scan's subject and its fate is
 * settled, whether that meant a judged pair or no qualifying neighbor at all. Stamping only
 * retires a node from being picked as a subject again; it stays eligible to turn up as someone
 * else's neighbor, so a future restatement is a new node whose own turn as subject finds this
 * one waiting for it. Without this mark the scan re-examines the same subjects forever and never
 * reaches deeper into the current population.
 */
export const CLAIM_DEDUP_SCAN_PREFIX = 'claim_dedup.scan:';

export function claimDedupScanKey(nodeId: string): string {
  return `${CLAIM_DEDUP_SCAN_PREFIX}${nodeId}`;
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
