/**
 * The pure half of association inference. No graph, no SQLite: just the combinatorics and
 * the idempotency key an episode's entity list reduces to. The Cypher lives
 * in `infrastructure/graph/association-queries.ts`; the SQLite gate lives in the stage that
 * calls this.
 */

export type EntityPair = {
  readonly sourceId: string;
  readonly targetId: string;
};

/**
 * Every unique unordered pair among distinct entity ids, `sourceId < targetId` throughout so
 * the same entity set produces the same pair list regardless of the order it arrived in. Two
 * entities pair once; an entity never pairs with itself.
 */
export function coOccurringPairs(entityIds: readonly string[]): readonly EntityPair[] {
  const sorted = [...new Set(entityIds)].sort();
  const pairs: EntityPair[] = [];
  for (const [i, sourceId] of sorted.entries()) {
    for (const targetId of sorted.slice(i + 1)) {
      pairs.push({ sourceId, targetId });
    }
  }
  return pairs;
}

/**
 * What one pair of an episode's all-pairs clique is worth the first time it is written.
 *
 * The share is `1 / pairCount`, floored. An episode naming n entities mints n(n-1)/2 pairs and
 * asserts nothing about any one of them beyond having named both, so the evidence one birth
 * carries is the whole of the episode's one observation divided by the pairs it spent it on. A
 * two-entity episode says one thing and its only pair gets all of it; a thirty-entity episode
 * mints 435 pairs and each of them is born barely traversable.
 *
 * The floor is the plateau, and it is `hebbian.weightFloor` rather than a number of its own: an
 * edge written under it is one recall refuses to walk the moment it is made, which deletes the
 * information rather than weighting it. At the shipped floor of 0.1 the plateau starts at five
 * entities, where `1/10` first falls under it, so every episode from five entities up births at
 * the floor and is told apart by repetition instead of by width.
 *
 * Repetition is what promotes: the birth is a step and not a target (`edges.ts`'s
 * `bounded_step`), so a pair two dense episodes both name climbs 0.1, 0.19, 0.271 and a pair
 * named once stays at the floor for decay to bury. Nothing is deleted, nothing is capped and
 * nothing is gated; the weighting alone is the whole mechanism.
 *
 * This is not `cliqueDiscount`. That is the per-node allocation the reinforcement queue folds a
 * burst under, `1 / (n - 1)`, and it answers a different question: what one co-activation signal
 * inside a burst is worth. The two are deliberately separate numbers for the two separate
 * writes, and collapsing them would tie a birth's weight to a fold's.
 */
export function coOccurrenceBirthStrength(pairCount: number, weightFloor: number): number {
  return Math.max(weightFloor, 1 / Math.max(1, pairCount));
}

/**
 * Scopes co-occurrence idempotency to the episode: the stage checks this key before writing
 * any `CO_OCCURS` edge and marks it once every pair has landed, so re-running the same
 * episode's pipeline (the crash-before-ledger-mark case the orchestrator contract calls out)
 * replays as a no-op, while a second, different episode sharing a pair still bumps the edge's
 * observation count.
 *
 * One row per episode, not one per pair. A per-pair key is n²: at the pinned `maxEntities`
 * of 32 a single rich episode writes 496 ledger rows, nothing prunes the ops ledger, and the
 * family outgrows every other key in it by an order of magnitude. What the coarser key gives
 * up is the interrupted run: a crash partway through the pair loop replays the pairs already
 * written and counts them a second time, which is the same re-observation semantics
 * `MENTIONS` already carries by design and is bounded by the worker's attempt limit.
 *
 * The pipeline version forks the key, so a run under new extraction rules pairs the episode's
 * entities again rather than reading the old version's mark as its own.
 */
export function coOccursLedgerKey(pipelineVersion: string, episodeId: string): string {
  return `association.co_occurs:${pipelineVersion}:${episodeId}`;
}
