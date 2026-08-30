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
 */
export function coOccursLedgerKey(episodeId: string): string {
  return `association.co_occurs:${episodeId}`;
}
