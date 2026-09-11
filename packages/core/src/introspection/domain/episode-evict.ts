import type { EvictionDemand, HealthSnapshot } from './health.js';

/**
 * How much a reading calls for an eviction run.
 *
 * Work a committed receipt already created answers the whole question on its own. It is not
 * urgency for its own sake: an unsettled publication holds the guard in front of every writer on
 * the substrate, and a survivor whose context was computed from a neighbourhood that no longer
 * exists is serving a vector nobody would stand behind. Both are known from durable records, so
 * both survive a census nobody could take.
 *
 * Qualification age is deliberately absent from the score. Every source counted here has already
 * cleared the maturation window, so weighting on age again would rank one qualified source above
 * another on a question the eligibility fence has settled. Unavailable is scored zero and named
 * as unavailable, because a census nobody took is not a population of nothing.
 */

export type EvictionRelevanceScales = {
  /** Attempts one invocation makes, which is what the eligible population is scored against. */
  readonly batch: number;
};

/** Known work a receipt already bought outranks any fresh reading; it is the run's first act. */
export const EVICTION_RECOVERY_RELEVANCE = 1;

export function evictionRelevance(demand: EvictionDemand, scales: EvictionRelevanceScales): number {
  if (demand.pendingRecovery === true || (demand.pendingSurvivorWork ?? 0) > 0) {
    return EVICTION_RECOVERY_RELEVANCE;
  }
  if (scales.batch <= 0) {
    return 0;
  }
  if (demand.availability !== 'measured' || demand.eligibleSources === undefined) {
    return 0;
  }
  if (demand.eligibleSources === 0) {
    return 0;
  }
  return Math.min(1, demand.eligibleSources / scales.batch);
}

export function episodeEvictRelevance(
  health: HealthSnapshot,
  scales: EvictionRelevanceScales,
): number {
  return evictionRelevance(health.eviction, scales);
}
