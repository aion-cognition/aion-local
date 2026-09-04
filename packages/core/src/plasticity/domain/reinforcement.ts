/**
 * The pure Hebbian update: the bounded rule, the per-trigger rates, and the fold from a
 * window of queued signals down to one step per pair. No SQLite, no Cypher.
 *
 * The rule is bounded: `w' = w + eta * (1 - w)`. The `(1 - w)` term is what makes
 * reinforcement diminish: an edge at 0.5 gains 0.05 per full-rate step, an edge at 0.9 gains
 * 0.01, and no sequence of steps reaches 1.0. Early co-activations move a weight the most,
 * which is the property worth having, since the first few carry the most information.
 *
 * A window is one flush's claimed batch, not a wall-clock interval. All of a pair's signals
 * inside that batch fold into a single bounded application: N signals for one pair raise the
 * pair's effective learning rate toward the base rate and stop there, they never apply N
 * compounding steps. Two consequences worth naming. A pair that fires ten times
 * between two flushes moves as far as a pair that fired once, so a tight loop cannot pump an
 * edge to 1.0 in one pass. And the same ten signals split across two flushes apply two steps
 * rather than one, so flush cadence changes how fast weights move; that is the cost of a
 * batch bound, and the asymptote keeps the difference small.
 */

/**
 * Recall's trigger string. It is declared here, beside the policy table keyed on it, and the
 * side effect that enqueues it imports it, so the producer and the flush cannot drift.
 */
export const RECALL_CO_ACTIVATION_TRIGGER = 'recall_co_activation';

/** Reflection's trigger string, imported by the stage that enqueues it. */
export const REFLECTION_CO_EXTRACTION_TRIGGER = 'reflection:co-extraction';

export type TriggerPolicy = {
  /** Multiplier on the base learning rate for this trigger. */
  readonly etaFactor: number;
  /** Whether the signal is one edge of an all-pairs clique and shares its evidence across it. */
  readonly cliqueDiscounted: boolean;
};

/**
 * What each trigger's evidence is worth.
 *
 * Recall co-activation is a measurement: spreading activation ranked these nodes and only the
 * strongest handful reach the queue, so a signal stands for its own pair and takes the full
 * rate. Reflection co-extraction is an assertion about an episode, not about a pair: every
 * entity the episode produced is paired with every other one whether or not the text related
 * them. It takes 0.3 of the rate and it takes the clique discount, which is the pair of
 * corrections that keeps a rich episode from reading as hundreds of equally strong facts.
 */
export const TRIGGER_POLICIES: Readonly<Record<string, TriggerPolicy>> = {
  [RECALL_CO_ACTIVATION_TRIGGER]: { etaFactor: 1, cliqueDiscounted: false },
  [REFLECTION_CO_EXTRACTION_TRIGGER]: { etaFactor: 0.3, cliqueDiscounted: true },
};

/**
 * An unrecognised trigger reinforces at the base rate with no discount. A row written by an
 * older build, or by a producer whose policy has not landed yet, still applies one bounded
 * step; dropping the signal instead would make an unknown trigger silently inert.
 */
export const DEFAULT_TRIGGER_POLICY: TriggerPolicy = { etaFactor: 1, cliqueDiscounted: false };

/**
 * The queue's `trigger` column is free-form text, so the lookup asks the table for its own keys
 * rather than reading through the prototype: a row spelling `constructor` would otherwise
 * return `Object` and carry an undefined rate into the fold.
 */
export function triggerPolicy(trigger: string): TriggerPolicy {
  return Object.hasOwn(TRIGGER_POLICIES, trigger)
    ? (TRIGGER_POLICIES[trigger] ?? DEFAULT_TRIGGER_POLICY)
    : DEFAULT_TRIGGER_POLICY;
}

export type QueuedSignal = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly trigger: string;
  readonly ts: string;
};

/**
 * One producer's fan-out, which is the unit a clique size is measured over. Both producers
 * stamp every pair of one burst with one timestamp: an episode's co-extraction pairs, or one
 * recall's co-activated pairs. Two bursts of the same trigger landing in the same millisecond
 * merge into one group and read as a larger clique, which discounts them further; a burst
 * split by the queue cap reads as a smaller one. Both errors move the applied weight, never
 * the bound.
 *
 * The two halves join on a NUL, which neither a trigger name nor a timestamp can contain, so
 * two different bursts cannot fold to one key. Written as the `\u0000` escape rather than as
 * the byte itself: a literal NUL in the source makes git read the whole file as binary and
 * drop diff, blame, and text search for it.
 */
export function signalGroupKey(signal: Pick<QueuedSignal, 'trigger' | 'ts'>): string {
  return `${signal.trigger}\u0000${signal.ts}`;
}

/** The window split into the bursts its producers stamped, keyed by `signalGroupKey`. */
function bursts(signals: readonly QueuedSignal[]): ReadonlyMap<string, readonly QueuedSignal[]> {
  const groups = new Map<string, QueuedSignal[]>();
  for (const signal of signals) {
    const key = signalGroupKey(signal);
    const held = groups.get(key) ?? [];
    held.push(signal);
    groups.set(key, held);
  }
  return groups;
}

/**
 * How many distinct nodes one burst touched, counted from the endpoints rather than from the
 * pair count. Counting endpoints is exact whether or not the burst arrived whole; inverting
 * `pairs = n(n-1)/2` is not.
 */
function burstSize(group: readonly QueuedSignal[]): number {
  const members = new Set<string>();
  for (const signal of group) {
    members.add(signal.sourceId);
    members.add(signal.targetId);
  }
  return members.size;
}

/** The same count for every burst in a window. */
export function cliqueSizes(signals: readonly QueuedSignal[]): ReadonlyMap<string, number> {
  return new Map([...bursts(signals)].map(([key, group]) => [key, burstSize(group)]));
}

/**
 * The share of one burst's evidence that a single pair in it carries: `1 / max(1, n - 1)`.
 *
 * An episode naming n entities enqueues n(n-1)/2 pairs, so without a discount its signal
 * grows with the square of how much the episode talked about, and one dense episode outweighs
 * a hundred focused ones. Dividing by n-1 is the per-node reading: each node splits one node's
 * worth of evidence across the n-1 partners the episode gave it, so the burst's total scales
 * with n rather than n squared. A pair (n = 2) keeps its full signal, and so does a degenerate
 * group of one.
 */
export function cliqueDiscount(cliqueSize: number): number {
  return 1 / Math.max(1, cliqueSize - 1);
}

/** A signal's weight before the base rate is applied: its trigger's factor, discounted if its trigger is clique-shaped. */
export function signalWeight(signal: QueuedSignal, cliqueSize: number): number {
  const policy = triggerPolicy(signal.trigger);
  if (!policy.cliqueDiscounted) {
    return policy.etaFactor;
  }
  return policy.etaFactor * cliqueDiscount(cliqueSize);
}

/**
 * Endpoint order carries no meaning here, so both directions of one pair fold together. The
 * ids join on the same NUL escape `signalGroupKey` uses, and for the same two reasons.
 */
export function pairKey(sourceId: string, targetId: string): string {
  return sourceId <= targetId ? `${sourceId}\u0000${targetId}` : `${targetId}\u0000${sourceId}`;
}

export type AggregatedPair = {
  readonly sourceId: string;
  readonly targetId: string;
  /** Queue rows that folded into this pair's step. */
  readonly signalCount: number;
  /** Summed signal weights before the clamp. At or above 1 the pair spent a whole step. */
  readonly effectiveSignal: number;
  /** The eta this pair's single bounded step applies. */
  readonly learningRate: number;
};

/**
 * One window of signals folded to one step per pair, ordered by pair so the same window
 * always produces the same write.
 *
 * The clamp on `effectiveSignal` is the fold: a pair's summed evidence buys at most one
 * full-rate step per window. Pairs whose evidence rounds to nothing are dropped rather than
 * written with a zero step, and a self-pair is dropped outright; neither producer emits one,
 * and an edge from a node to itself is not a co-activation.
 */
export function aggregateWindow(
  signals: readonly QueuedSignal[],
  baseLearningRate: number,
): readonly AggregatedPair[] {
  const totals = new Map<
    string,
    { sourceId: string; targetId: string; count: number; signal: number }
  >();

  for (const group of bursts(signals).values()) {
    const size = burstSize(group);
    for (const signal of group) {
      if (signal.sourceId === signal.targetId) {
        continue;
      }
      const key = pairKey(signal.sourceId, signal.targetId);
      const entry = totals.get(key) ?? {
        sourceId: signal.sourceId <= signal.targetId ? signal.sourceId : signal.targetId,
        targetId: signal.sourceId <= signal.targetId ? signal.targetId : signal.sourceId,
        count: 0,
        signal: 0,
      };
      entry.count += 1;
      entry.signal += signalWeight(signal, size);
      totals.set(key, entry);
    }
  }

  return [...totals.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, entry]) => ({
      sourceId: entry.sourceId,
      targetId: entry.targetId,
      signalCount: entry.count,
      effectiveSignal: entry.signal,
      learningRate: baseLearningRate * Math.min(1, entry.signal),
    }))
    .filter((pair) => pair.learningRate > 0);
}

/**
 * The rule itself, and the same arithmetic the Cypher applies, so a test can state the
 * expected weight without a server. The floor is a lower bound on the result, which
 * reinforcement can only reach by starting under it: a step raises the weight whenever eta is
 * positive and the weight is under 1.
 */
export function boundedReinforcement(
  weight: number,
  learningRate: number,
  weightFloor: number,
): number {
  const raw = weight + learningRate * (1 - weight);
  if (raw < weightFloor) {
    return weightFloor;
  }
  if (raw > 1) {
    return 1;
  }
  return raw;
}
