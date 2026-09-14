/**
 * The two outcome observations `propagate` in `activation.ts` collects alongside the ordinary
 * activation math, split into their own file to keep that one at a readable size. Neither type
 * here feeds a score, a threshold, or a termination condition; both are telemetry the recall
 * application layer turns into usage-stream rows once the walk finishes.
 */

/**
 * One propagation across a bridge leg: activation moved either `into` the Bridge node from one
 * of its endpoints, or `out` of it toward the other. The edge has to be one of that bridge's own
 * recorded legs, which `adjacency.ts` establishes from the relation and the signal `writeBridge`
 * stamped on it; an unrelated association that merely touches the Bridge node is not a leg and
 * produces no entry here.
 *
 * A run that sees both directions for the same `bridgeId` crossed the bridge end to end in this
 * walk: the two legs run to the two different endpoints, and the walk's visited set stops the
 * `out` leg from returning to the endpoint the `into` leg came from. A run that sees only one
 * made a leg contribution without a crossing. Recorded from what `propagate` actually observed,
 * never inferred from the strongest path string or from which nodes a later pack happens to
 * print.
 */
export type BridgeLegContribution = {
  readonly bridgeId: string;
  readonly direction: 'into' | 'out';
};

/**
 * Physical-degree hub inhibition, summarized over the whole walk rather than carried per hop:
 * `hops` is every propagation this run evaluated, `inhibitedHops` how many took less than the
 * uninhibited multiplier, and `totalPenalty`/`minPenalty` the sum and floor of the multiplier
 * actually applied. `degree` throughout `activation.ts` is physical degree; a walk that also
 * measured active degree is a different number this summary does not carry.
 */
export type HubPenaltyObserved = {
  readonly hops: number;
  readonly inhibitedHops: number;
  readonly totalPenalty: number;
  readonly minPenalty: number;
};

/** Folds every hop's hub-inhibition multiplier into the walk's own summary, once, at the end. */
export function foldHubPenalties(penalties: readonly number[]): HubPenaltyObserved {
  let inhibitedHops = 0;
  let totalPenalty = 0;
  let minPenalty = 1;
  for (const penalty of penalties) {
    if (penalty < 1) {
      inhibitedHops += 1;
    }
    totalPenalty += penalty;
    minPenalty = Math.min(minPenalty, penalty);
  }
  return { hops: penalties.length, inhibitedHops, totalPenalty, minPenalty };
}
