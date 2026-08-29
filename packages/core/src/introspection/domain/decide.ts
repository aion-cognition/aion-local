import { HEALTH_COLLECTORS, type HealthSnapshot, type OperationEffectiveness } from './health.js';
import type { OperationTier } from './operation.js';

/**
 * Which maintenance operation to run this cycle, decided from one snapshot and nothing else.
 * Pure, so the same reading always produces the same answer and a decision can be argued from
 * the numbers rather than from a log line.
 *
 * Three tiers, in order. Tier 1 answers a condition that is already degrading recall and
 * preempts everything, unweighted: an emergency does not negotiate with an operation's track
 * record. Tier 2 scores the routine catalog by how much the snapshot calls for each operation,
 * lowered for operations that have not been working and raised the longer one has been passed
 * over. Tier 3 is the model-guided layer, and it is opt-in and inert here (see the engine's
 * advisor seam).
 */

/** Below this, a significant share of the substrate is invisible to vector search. */
export const CRITICAL_VECTOR_PARITY = 0.8;

/** Above this, the graph has fragmented into pieces spreading activation cannot cross. */
export const CRITICAL_ORPHAN_SHARE = 0.3;

/**
 * Neither share means anything on a substrate this small: one unvectorized node out of five is
 * a parity of 0.8, and the reflection worker's own pending-vector drain is already on it.
 */
export const CRITICAL_MIN_POPULATION = 20;

/** What an operation's urgency is multiplied by once its effectiveness falls under the floor. */
export const DEPRIORITIZED_WEIGHT = 0.5;

export type CriticalCondition = 'vector_parity' | 'orphan_share' | 'missing_backbone_links';

/**
 * The tier-1 conditions this snapshot meets, in the order they degrade recall. A tier-1
 * operation reads this rather than re-deriving the thresholds, so the condition that selects
 * an operation and the condition the operation repairs cannot drift apart.
 */
export function criticalConditions(health: HealthSnapshot): readonly CriticalCondition[] {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return [];
  }
  const conditions: CriticalCondition[] = [];
  if (health.graph.episodesWithoutSession > 0) {
    conditions.push('missing_backbone_links');
  }
  if (
    health.graph.vectorExpected >= CRITICAL_MIN_POPULATION &&
    health.graph.vectorParity < CRITICAL_VECTOR_PARITY
  ) {
    conditions.push('vector_parity');
  }
  if (
    health.graph.nodes >= CRITICAL_MIN_POPULATION &&
    health.graph.orphanShare > CRITICAL_ORPHAN_SHARE
  ) {
    conditions.push('orphan_share');
  }
  return conditions;
}

export type OperationCandidate = {
  readonly name: string;
  readonly tier: OperationTier;
  /** What the operation's own `relevance` returned for this snapshot, on 0 to 1. */
  readonly relevance: number;
};

export type DecisionInput = {
  readonly health: HealthSnapshot;
  readonly candidates: readonly OperationCandidate[];
  /** Cycles of being passed over that double an operation's urgency. */
  readonly starvationCycles: number;
  /** Urgency a tier-2 operation must reach to be selected at all. */
  readonly urgencyThreshold: number;
  /** Effectiveness below which an operation is weighted down but never excluded. */
  readonly effectivenessFloor: number;
  readonly tier3Enabled: boolean;
};

export type ScoredCandidate = OperationCandidate & {
  readonly urgency: number;
  readonly cyclesSinceSelected: number;
  readonly effectiveness: number;
};

export type Decision =
  | {
      readonly kind: 'selected';
      readonly name: string;
      readonly tier: OperationTier;
      readonly urgency: number;
      readonly reason: string;
    }
  | { readonly kind: 'tier3'; readonly reason: string }
  | { readonly kind: 'idle'; readonly reason: string };

const UNTRIED_EFFECTIVENESS = 1;

function statsFor(
  health: HealthSnapshot,
  name: string,
): Pick<OperationEffectiveness, 'effectiveness' | 'cyclesSinceSelected'> {
  const found = health.effectiveness.find((entry) => entry.name === name);
  if (found === undefined) {
    return { effectiveness: UNTRIED_EFFECTIVENESS, cyclesSinceSelected: 0 };
  }
  return { effectiveness: found.effectiveness, cyclesSinceSelected: found.cyclesSinceSelected };
}

/**
 * Linear and uncapped above the configured span. An operation with real work waiting therefore
 * crosses the threshold eventually however small its relevance, which is the whole point;
 * an operation with nothing to do stays at zero however long it waits, because the boost is a
 * multiplier and not an addition.
 */
export function starvationBoost(cyclesSinceSelected: number, starvationCycles: number): number {
  if (starvationCycles <= 0) {
    return 1;
  }
  return 1 + Math.max(0, cyclesSinceSelected) / starvationCycles;
}

export function scoreCandidate(
  candidate: OperationCandidate,
  input: DecisionInput,
): ScoredCandidate {
  const { effectiveness, cyclesSinceSelected } = statsFor(input.health, candidate.name);
  const weight = effectiveness < input.effectivenessFloor ? DEPRIORITIZED_WEIGHT : 1;
  const urgency =
    candidate.relevance * weight * starvationBoost(cyclesSinceSelected, input.starvationCycles);
  return { ...candidate, urgency, cyclesSinceSelected, effectiveness };
}

/** Highest urgency, then the one that has waited longest, then the name, so ties never depend on registration order. */
function bestBy(
  candidates: readonly ScoredCandidate[],
  score: (candidate: ScoredCandidate) => number,
): ScoredCandidate | undefined {
  let best: ScoredCandidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const delta = score(candidate) - score(best);
    if (delta > 0) {
      best = candidate;
      continue;
    }
    if (delta < 0) {
      continue;
    }
    if (candidate.cyclesSinceSelected > best.cyclesSinceSelected) {
      best = candidate;
      continue;
    }
    if (candidate.cyclesSinceSelected === best.cyclesSinceSelected && candidate.name < best.name) {
      best = candidate;
    }
  }
  return best;
}

export function decide(input: DecisionInput): Decision {
  const scored = input.candidates.map((candidate) => scoreCandidate(candidate, input));

  const critical = scored.filter(
    (candidate) => candidate.tier === 1 && candidate.relevance > 0,
  );
  const emergency = bestBy(critical, (candidate) => candidate.relevance);
  if (emergency !== undefined) {
    const conditions = criticalConditions(input.health);
    return {
      kind: 'selected',
      name: emergency.name,
      tier: 1,
      urgency: emergency.relevance,
      reason: `critical: ${conditions.length === 0 ? 'operation-declared' : conditions.join(', ')}`,
    };
  }

  const routine = scored.filter(
    (candidate) =>
      candidate.tier === 2 &&
      candidate.relevance > 0 &&
      candidate.urgency >= input.urgencyThreshold,
  );
  const chosen = bestBy(routine, (candidate) => candidate.urgency);
  if (chosen !== undefined) {
    return {
      kind: 'selected',
      name: chosen.name,
      tier: 2,
      urgency: chosen.urgency,
      reason:
        `urgency ${chosen.urgency.toFixed(3)} ` +
        `(relevance ${chosen.relevance.toFixed(3)}, ` +
        `${String(chosen.cyclesSinceSelected)} cycles waiting, ` +
        `effectiveness ${chosen.effectiveness.toFixed(2)})`,
    };
  }

  if (input.tier3Enabled) {
    return { kind: 'tier3', reason: 'no operation cleared the urgency threshold' };
  }
  return { kind: 'idle', reason: 'no operation cleared the urgency threshold' };
}
