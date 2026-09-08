/**
 * The entity cascade's per-run counters, split out once the stage alone passed the repo's line
 * cap. Withheld work is counted apart from judged work, and blocked work apart from the rest,
 * because a run that could not ask has not decided anything.
 */

export type CascadeTally = {
  readonly merges: number;
  readonly groups: number;
  readonly proposals: number;
  readonly judged: number;
  /** Pairs tier 1 put forward, which is what `judged` has to be read against. */
  readonly nominated: number;
  /** Pairs nobody was asked about, because their required evidence did not support asking. */
  readonly withheld: number;
  /** Of those, the ones a proved suppression blocks until the source comes back. */
  readonly blocked: number;
};

export const NOTHING_DONE: CascadeTally = {
  merges: 0,
  groups: 0,
  proposals: 0,
  judged: 0,
  nominated: 0,
  withheld: 0,
  blocked: 0,
};

export function addTallies(left: CascadeTally, right: CascadeTally): CascadeTally {
  return {
    merges: left.merges + right.merges,
    groups: left.groups + right.groups,
    proposals: left.proposals + right.proposals,
    judged: left.judged + right.judged,
    nominated: left.nominated + right.nominated,
    withheld: left.withheld + right.withheld,
    blocked: left.blocked + right.blocked,
  };
}
