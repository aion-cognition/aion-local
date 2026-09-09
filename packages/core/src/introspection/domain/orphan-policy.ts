/**
 * One action policy for disconnected nodes, shared by the scan, the health reading and the
 * guarded write so the three cannot decide different things about the same node.
 *
 * Physical disconnection is a diagnostic. It says spreading activation cannot reach a node
 * through associations, which is a real fragmentation reading and is not on its own a reason to
 * suppress anything: an archive-supported memory whose raw containers were evicted is
 * disconnected and is exactly the memory the substrate exists to keep. What decides a repair is
 * support, and unknown support decides nothing at all.
 */

export type OrphanSupport = 'supported' | 'unsupported' | 'unknown';

export type OrphanCandidate = {
  readonly nodeId: string;
  readonly support: OrphanSupport;
  /** A current retained target the existing shared-source or same-container rule reached. */
  readonly relinkTarget: string | undefined;
  /** A proposal or judgment still pending on this node, which protects it from a close. */
  readonly protectedByPendingWork: boolean;
  /** When the whole unsupported predicate first certified and has held since. */
  readonly qualifiedSince: Date | undefined;
};

export type OrphanAction =
  /** Reconnect it: cheap, weak, and reversible by the real association that arrives later. */
  | 'relink'
  /** Suppress it: certified unsupported, nothing to relink to, and qualified long enough. */
  | 'forget'
  /** Nothing to do yet, and the record says which of the reasons it is. */
  | 'hold';

export type OrphanDecision = {
  readonly action: OrphanAction;
  readonly reason: string;
  /** Whether this node is demand a repair run could actually act on now. */
  readonly actionable: boolean;
};

export type OrphanPolicy = {
  readonly now: Date;
  readonly forgetAfterDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What to do with one disconnected node.
 *
 * The order is deliberate. A relink is preferred over a forget wherever one exists, because
 * reconnecting is reversible and suppression is not. Support outranks both: a supported node is
 * never forgotten however long it has been disconnected, and an unknown one is never forgotten at
 * all, since the census that would have found its support is the census nobody took.
 */
export function decideOrphan(candidate: OrphanCandidate, policy: OrphanPolicy): OrphanDecision {
  // Unknown support decides nothing at all, and that includes a relink. A guessed edge onto a
  // node whose records nobody has counted is a claim made out of the same silence a forget would
  // have been made out of; it is cheaper to undo and it is still a claim.
  if (candidate.support === 'unknown') {
    return { action: 'hold', reason: 'support is uncounted', actionable: false };
  }
  if (candidate.relinkTarget !== undefined) {
    return { action: 'relink', reason: 'a current retained target is reachable', actionable: true };
  }
  if (candidate.support === 'supported') {
    return { action: 'hold', reason: 'the records still hold it up', actionable: false };
  }
  if (candidate.protectedByPendingWork) {
    return { action: 'hold', reason: 'a judgment is still pending on it', actionable: false };
  }
  if (candidate.qualifiedSince === undefined) {
    return { action: 'hold', reason: 'no qualification record', actionable: false };
  }
  const age = policy.now.getTime() - candidate.qualifiedSince.getTime();
  if (age < policy.forgetAfterDays * DAY_MS) {
    return {
      action: 'hold',
      reason: 'certified unsupported but not yet mature',
      actionable: false,
    };
  }
  return { action: 'forget', reason: 'unsupported and mature', actionable: true };
}

/**
 * How much of a batch this population would actually fill. Structural nodes and sources still
 * being processed never reach here, so they cannot inflate the demand a repair is scored on.
 */
export function actionableDemand(decisions: readonly OrphanDecision[]): number {
  return decisions.filter((decision) => decision.actionable).length;
}

/**
 * The tier-2 relevance of a repair run: nothing to do is zero, and a batch's worth of work is
 * one. It is demand rather than a share of the graph, because the share moves with the
 * substrate's shape and says nothing about whether a run has anything to do.
 */
export function orphanRepairRelevance(actionable: number, configuredBatch: number): number {
  if (actionable <= 0 || configuredBatch <= 0) {
    return 0;
  }
  return Math.min(1, actionable / configuredBatch);
}
