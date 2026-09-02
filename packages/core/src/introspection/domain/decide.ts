import {
  criticalConditions,
  type CriticalCondition,
  type HealthSnapshot,
  type OperationEffectiveness,
} from './health.js';
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
 *
 * Tier is a property of the cycle, not of the operation. An operation earns tier 1 for one
 * cycle by naming a critical condition the snapshot actually meets; the rest of the time the
 * same operation is scored routinely beside everything else. That is what stops a permanent
 * pathology from being a permanent preemption.
 */

/** What an operation's urgency is multiplied by once its effectiveness falls under the floor. */
export const DEPRIORITIZED_WEIGHT = 0.5;

/**
 * Runs at or under this cost pay nothing; the divisor rises from here. Intended knob:
 * `maintenance.costReferenceMs`.
 */
const COST_REFERENCE_MS = 1_000;

/**
 * Decades of cost above the reference the divisor spreads over. The catalog's own runs span
 * about three, from a SQLite tally to a batch of model calls. Intended knob:
 * `maintenance.costDecades`.
 */
const COST_DECADES = 3;

/**
 * The most an operation's cost may divide its urgency, so cost is a tie-breaker between
 * comparable candidates and never a veto: the dearest operation in the catalog still crosses the
 * threshold on a reading that calls for it, and starvation still reaches it. Intended knob:
 * `maintenance.maxCostDivisor`.
 */
const MAX_COST_DIVISOR = 2;

/**
 * Resolved runs a critical operation gets before its own record can cost it the preemption.
 * A real emergency is repaired in a few bounded batches and keeps preempting throughout;
 * an operation still selected on the same condition after this many runs that never moved
 * its metric is not repairing it, and the rest of the catalog must not wait on it.
 */
export const CRITICAL_PREEMPTION_GRACE_RUNS = 3;

export type OperationCandidate = {
  readonly name: string;
  /**
   * The tier-1 condition this operation repairs, when it declares one. It preempts on the
   * cycles the snapshot meets that condition and is scored routinely on every other cycle.
   */
  readonly answers?: CriticalCondition;
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
  /** Undefined where no declared metric has scored a run, which weights nothing either way. */
  readonly effectiveness: number | undefined;
  /** Runs that have resolved, which is what the preemption grace is counted in. */
  readonly runs: number;
  /** What a run of this operation typically costs; undefined until one has been timed. */
  readonly meanDurationMs: number | undefined;
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

type CandidateRecord = Pick<
  OperationEffectiveness,
  'effectiveness' | 'cyclesSinceSelected' | 'runs' | 'meanDurationMs'
>;

/** No record at all reads the same as a record nothing has scored: unmeasured, and unweighted. */
function statsFor(health: HealthSnapshot, name: string): CandidateRecord {
  const found = health.effectiveness.find((entry) => entry.name === name);
  if (found === undefined) {
    return {
      effectiveness: undefined,
      cyclesSinceSelected: 0,
      runs: 0,
      meanDurationMs: undefined,
    };
  }
  return {
    effectiveness: found.effectiveness,
    cyclesSinceSelected: found.cyclesSinceSelected,
    runs: found.runs,
    meanDurationMs: found.meanDurationMs,
  };
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

/**
 * A mild cost term, so that between two operations a reading calls for equally the cheaper one
 * runs first. It flattens at both ends by design: everything at or under the reference is free,
 * and everything past the catalog's cost span pays the same ceiling, which keeps one very slow
 * operation from being scheduled out of existence.
 */
export function costDivisor(meanDurationMs: number | undefined): number {
  if (meanDurationMs === undefined || meanDurationMs <= COST_REFERENCE_MS) {
    return 1;
  }
  const decades = Math.min(COST_DECADES, Math.log10(meanDurationMs / COST_REFERENCE_MS));
  return 1 + (decades / COST_DECADES) * (MAX_COST_DIVISOR - 1);
}

/**
 * Effectiveness weights urgency only where a declared metric produced it. An operation with no
 * metric behind its record is scored on relevance, waiting time, and cost alone, which is
 * everything about it that is actually known.
 */
export function scoreCandidate(
  candidate: OperationCandidate,
  input: DecisionInput,
): ScoredCandidate {
  const { effectiveness, cyclesSinceSelected, runs, meanDurationMs } = statsFor(
    input.health,
    candidate.name,
  );
  const weight =
    effectiveness !== undefined && effectiveness < input.effectivenessFloor
      ? DEPRIORITIZED_WEIGHT
      : 1;
  const urgency =
    (candidate.relevance * weight * starvationBoost(cyclesSinceSelected, input.starvationCycles)) /
    costDivisor(meanDurationMs);
  return { ...candidate, urgency, cyclesSinceSelected, effectiveness, runs, meanDurationMs };
}

/**
 * Whether this operation may still preempt the routine catalog on the condition it answers.
 *
 * Preemption is the one place urgency scoring, the effectiveness weight, and starvation
 * protection are all bypassed, so it needs its own way out. An operation inside its grace
 * always preempts, which is what an emergency is for. Past the grace it keeps preempting only
 * while it is still moving the metric it declared: the condition it answers may stand for
 * weeks (an unenriched backlog reads as fragmentation until reflection drains it), and nothing
 * else in the catalog may be blocked for that long.
 *
 * An operation with no scored metric keeps its preemption. Every tier-1 responder in the catalog
 * declares one, so this is the answer for a responder registered without one: an emergency that
 * cannot be scored is not the same thing as an emergency that failed to repair anything, and
 * withdrawing the preemption on a reading nothing produced would be a verdict from silence.
 */
export function preemptionEarned(candidate: ScoredCandidate, effectivenessFloor: number): boolean {
  if (candidate.runs < CRITICAL_PREEMPTION_GRACE_RUNS) {
    return true;
  }
  if (candidate.effectiveness === undefined) {
    return true;
  }
  return candidate.effectiveness >= effectivenessFloor;
}

/** The word the ledger and the logs use where there is no reading, so a reason never prints a stand-in number. */
export const UNMEASURED_EFFECTIVENESS = 'unmeasured';

export function describeEffectiveness(effectiveness: number | undefined): string {
  return effectiveness === undefined ? UNMEASURED_EFFECTIVENESS : effectiveness.toFixed(2);
}

/** An operation whose declared condition the snapshot meets, so the reason can name it outright. */
type CriticalCandidate = ScoredCandidate & { readonly answers: CriticalCondition };

/** Highest urgency, then the one that has waited longest, then the name, so ties never depend on registration order. */
function bestBy<T extends ScoredCandidate>(
  candidates: readonly T[],
  score: (candidate: T) => number,
): T | undefined {
  let best: T | undefined;
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
  const conditions = criticalConditions(input.health);

  const critical = scored.filter(
    (candidate): candidate is CriticalCandidate =>
      candidate.answers !== undefined &&
      conditions.includes(candidate.answers) &&
      candidate.relevance > 0 &&
      preemptionEarned(candidate, input.effectivenessFloor),
  );
  const emergency = bestBy(critical, (candidate) => candidate.relevance);
  if (emergency !== undefined) {
    return {
      kind: 'selected',
      name: emergency.name,
      tier: 1,
      urgency: emergency.relevance,
      // The condition this operation repairs, not every condition the snapshot meets: the
      // ledger has to say what the run was for, and a run answers one of them.
      reason: `critical: ${emergency.answers}`,
    };
  }

  const routine = scored.filter(
    (candidate) => candidate.relevance > 0 && candidate.urgency >= input.urgencyThreshold,
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
        `effectiveness ${describeEffectiveness(chosen.effectiveness)})`,
    };
  }

  if (input.tier3Enabled) {
    return { kind: 'tier3', reason: 'no operation cleared the urgency threshold' };
  }
  return { kind: 'idle', reason: 'no operation cleared the urgency threshold' };
}
