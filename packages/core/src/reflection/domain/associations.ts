/**
 * Whitepaper §6.6: the pure half of association inference. No graph, no SQLite — just the
 * combinatorics and the idempotency key an episode's entity list reduces to. The Cypher lives
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
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      pairs.push({ sourceId: sorted[i] as string, targetId: sorted[j] as string });
    }
  }
  return pairs;
}

/**
 * Scopes co-occurrence idempotency to one (episode, pair): the stage checks this key before
 * writing a `CO_OCCURS` edge and marks it after, so re-running the same episode's pipeline
 * (the crash-before-ledger-mark case the orchestrator contract calls out) replays as a no-op,
 * while a second, different episode sharing the pair still bumps the edge's observation count.
 * Pair order does not affect the key: the ids are sorted the same way `coOccurringPairs` sorts
 * them.
 */
export function coOccursLedgerKey(episodeId: string, sourceId: string, targetId: string): string {
  const [a, b] = sourceId <= targetId ? [sourceId, targetId] : [targetId, sourceId];
  return `association.co_occurs:${episodeId}:${a}:${b}`;
}
