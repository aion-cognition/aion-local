/**
 * The partition a frozen edge cohort is read through after work has run against it.
 *
 * A net count that went down proves nothing on its own: an edge disappears when a repair
 * closes it and also when the node it pointed at was removed, and those two are different
 * results. So every edge frozen at the baseline lands in exactly one of four classes, the four
 * sum back to the frozen count, and an edge that is simply gone with nothing accounting for it
 * is a flagged class rather than a silent subtraction.
 */

export const STALE_EDGE_CLASSES = [
  /** Frozen open, still open, and its target still does not stand. */
  'still_open',
  /** Frozen open and now closed, which is the repair doing its work. */
  'closed',
  /** Gone from the graph, and a committed removal manifest names it. */
  'removed_by_verified_eviction',
  /** Gone from the graph and nothing accounts for it. */
  'unexplained_missing',
] as const;

export type StaleEdgeClass = (typeof STALE_EDGE_CLASSES)[number];

/** One edge as the graph holds it now: `open` false means the edge is there and closed. */
export type ObservedEdgeState = {
  readonly id: string;
  readonly open: boolean;
  /** True when the narrative it points at no longer stands, which is what makes an open edge stale. */
  readonly targetClosed: boolean;
};

export type StaleEdgeCohortInput = {
  /** Exactly the edge ids the baseline froze, in the order the manifest records them. */
  readonly frozen: readonly string[];
  /** Every edge of the frozen kind the graph holds now, whatever its state. */
  readonly observed: readonly ObservedEdgeState[];
  /** Edge ids a committed removal manifest names. Absence alone never counts as eviction. */
  readonly removalManifest: Iterable<string>;
};

export type StaleEdgePartition = {
  readonly byClass: Readonly<Record<StaleEdgeClass, readonly string[]>>;
  readonly counts: Readonly<Record<StaleEdgeClass, number>>;
  /** The frozen membership size the four classes sum to. */
  readonly denominator: number;
  /**
   * Stale now and not in the frozen set. This holds both edges written since the freeze and
   * edges that were there and became stale when their target stopped standing, so a report
   * cannot read either as the original backlog shrinking or growing.
   */
  readonly newlyStale: readonly string[];
  /**
   * Frozen edges the removal manifest names that the graph still holds. The manifest and the
   * substrate disagree, which is a correctness flag rather than a class.
   */
  readonly manifestContradictions: readonly string[];
};

function emptyClasses(): Record<StaleEdgeClass, string[]> {
  return {
    still_open: [],
    closed: [],
    removed_by_verified_eviction: [],
    unexplained_missing: [],
  };
}

/**
 * Classification order is the order of evidence: what the graph still holds decides first,
 * and only an edge the graph does not hold is judged against the removal manifest.
 */
export function partitionStaleEdges(input: StaleEdgeCohortInput): StaleEdgePartition {
  const observed = new Map(input.observed.map((edge) => [edge.id, edge]));
  const removed = new Set(input.removalManifest);
  const frozen = new Set(input.frozen);

  const byClass = emptyClasses();
  const manifestContradictions: string[] = [];

  for (const id of input.frozen) {
    const state = observed.get(id);
    if (state === undefined) {
      byClass[removed.has(id) ? 'removed_by_verified_eviction' : 'unexplained_missing'].push(id);
      continue;
    }
    if (removed.has(id)) {
      manifestContradictions.push(id);
    }
    byClass[state.open ? 'still_open' : 'closed'].push(id);
  }

  const newlyStale = input.observed
    .filter((edge) => edge.open && edge.targetClosed && !frozen.has(edge.id))
    .map((edge) => edge.id);

  return {
    byClass,
    counts: {
      still_open: byClass.still_open.length,
      closed: byClass.closed.length,
      removed_by_verified_eviction: byClass.removed_by_verified_eviction.length,
      unexplained_missing: byClass.unexplained_missing.length,
    },
    denominator: frozen.size,
    newlyStale,
    manifestContradictions,
  };
}

/**
 * Whether the four classes account for the frozen membership exactly once each. A report that
 * cites the partition states this rather than assuming it, since a duplicated frozen id would
 * otherwise inflate one class and still look like a clean sum.
 */
export function partitionIsExhaustive(partition: StaleEdgePartition): boolean {
  const total =
    partition.counts.still_open +
    partition.counts.closed +
    partition.counts.removed_by_verified_eviction +
    partition.counts.unexplained_missing;
  const ids = new Set([
    ...partition.byClass.still_open,
    ...partition.byClass.closed,
    ...partition.byClass.removed_by_verified_eviction,
    ...partition.byClass.unexplained_missing,
  ]);
  return total === partition.denominator && ids.size === partition.denominator;
}
