import { describeEffectiveness, type OperationCandidate } from './decide.js';
import type { HealthSnapshot, OperationEffectiveness } from './health.js';
import type { Logger } from '../../infrastructure/logging/logger.js';

/**
 * The strategic tier: what the model may be asked, what it may answer, and the deterministic
 * rules that decide whether an answer is allowed to run.
 *
 * The constraint the whole tier is built on: a model-chosen run is an ordinary run. Whatever the
 * model names still passes the same bucket claim, the same protected relationship set, the same
 * bounded scope, and the same scoring every deterministic selection passes. What guards it is
 * the record those runs leave, not a second opinion asked before the first one is allowed to
 * count: a recommendation for an operation whose runs have stopped helping, or stopped
 * finishing, is weighted down by its own history.
 */

export type Tier3Request = {
  readonly health: HealthSnapshot;
  readonly candidates: readonly OperationCandidate[];
  /** Why the deterministic tiers selected nothing, which is the only reason tier 3 is consulted. */
  readonly reason: string;
  /**
   * What the loop learned from its recent runs, one line each, oldest first. The effectiveness
   * table says how often an operation helped; these say what happened, which is the difference
   * between a ratio and a reason.
   */
  readonly insights?: readonly string[];
  /**
   * The introspection senses' own evidence, one line each: what the substrate observed about
   * bridge traversal, resonance follow-through, judgment durability, compatibility calibration
   * and CO_OCCURS density. Read by the model exactly like `insights`, as evidence with limits.
   * Nothing in `acceptTier3Proposal` reads this field, and it is never a threshold on whether an
   * operation runs; it exists only so the model's own interpretation of it can become a lesson.
   */
  readonly senseEvidence?: readonly string[];
  /**
   * The model's own past interpretations of that evidence, oldest first, read back from
   * `introspection_model_lessons`. Kept apart from `insights`: those are the run ledger's own
   * numbers, and these are what a previous cycle's model concluded from the senses. A lesson is
   * shown as the model's prior reading, never blended into the sense evidence itself, so a wrong
   * early guess cannot pose as a second measurement corroborating the first.
   */
  readonly lessons?: readonly string[];
  /**
   * The loop's abort, carried on the request because the advisor is built once at wiring time
   * and the signal belongs to the engine. A consultation stops with the service rather than
   * holding shutdown for the rest of a model call.
   */
  readonly signal?: AbortSignal;
};

export type Tier3Proposal = {
  readonly operation: string;
  readonly confidence: number;
  readonly rationale: string;
};

/**
 * Four answers, kept apart on purpose. `declined` is the model saying the graph needs nothing,
 * which is a first-class answer and not a failure; `failed` is a call that threw or timed out,
 * and `unusable` an answer the schema refuses. A caller that folded the three into one silence
 * could not tell a healthy substrate from a broken advisor.
 *
 * `lesson` rides on the two answers a live model actually produced (`advised` and `declined`),
 * never on `failed` or `unusable`: those are the call not arriving in a shape anyone can read,
 * and there is no interpretation to carry forward from an answer that never resolved. It is the
 * model's own reading of the sense evidence, offered beside the operation choice rather than
 * folded into it, and the model may leave it out of either answer.
 *
 * `lessonRejected` is the other half of that separation: a lesson the model sent in a shape the
 * field does not take is discarded and named here, and the decision it arrived with is answered
 * on its own terms. An optional interpretation never decides whether a usable recommendation is
 * usable.
 */
export type Tier3Outcome =
  | {
      readonly status: 'advised';
      readonly proposal: Tier3Proposal;
      readonly lesson?: string;
      /** Why an offered lesson was thrown away. The decision beside it stands regardless. */
      readonly lessonRejected?: string;
    }
  | {
      readonly status: 'declined';
      readonly rationale: string;
      readonly lesson?: string;
      readonly lessonRejected?: string;
    }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'unusable'; readonly reason: string };

export type Tier3Advisor = (request: Tier3Request) => Promise<Tier3Outcome>;

/**
 * What a model-chosen run may never be, stated as the short list of things that cannot be taken
 * back. Everything else in the catalog is selectable, because a write the substrate can reverse
 * is a write its own record can judge, and the judging is what teaches the loop anything.
 *
 * A model-authored graph write is not irreversible. `symbiosis_bridge` writes one, and the
 * bridge is a stamped node with two edges that `aion forget` takes out of scope like any other;
 * excluding it also meant the deterministic tier could schedule an operation the strategic tier
 * could not name, which is an inversion rather than a safeguard. `merge_auto` was excluded for
 * an arming lane it no longer needs: a switched-off operation is filtered out of the candidate
 * set before the model sees it, so there is no second way to arm anything, and `aion unmerge`
 * reverses a merge one at a time. The tier-1 responders were excluded for second-guessing an
 * emergency, but tier 3 is consulted only on cycles where no critical condition holds, so there
 * is no emergency to second-guess.
 *
 * Each entry below names what it destroys.
 */
export const TIER3_DENIED_OPERATIONS: readonly string[] = [
  // The one hard delete in the system. Eviction removes a source's raw projection outright, and
  // no command puts the original text back once its coverage has replaced it.
  'episode_evict',
  // Rewrites stored node text in place rather than superseding it, so a wrong redaction
  // overwrites the content it was scrubbing and the original is gone.
  'redaction_residue_purge',
];

/**
 * What the record of an operation nothing has scored is worth. Neutral rather than zero: zero
 * would multiply every untried operation's confidence to nothing, and since a model-chosen run
 * is one of the ways an operation earns a record at all, that is a bar it could never clear.
 * A cold start is an absence of evidence, and this is the number that says so.
 */
export const NEUTRAL_EFFECTIVENESS_PRIOR = 0.5;

/**
 * The head start the execution weight's denominator carries, in runs. It is what stops one bad
 * tick from reading as a verdict: at two, a measureless operation's first failure costs it a
 * third of the neutral prior, and its fifth leaves it at 0.14. One would halve the weight on a
 * single failure, which is more than a fifteen-minute tick that threw once is worth.
 */
export const EXECUTION_PRIOR_RUNS = 2;

/**
 * What an operation with no declared metric has earned, read off the resolutions its own runs
 * already wrote.
 *
 * Effectiveness is undefined for twenty-one of the catalog's thirty-one operations, because
 * nothing in the snapshot can say whether a `community_refresh` helped. That is a reason not to
 * credit its successes. It was being read as a reason to ignore its failures too, which left an
 * operation with five recorded throws blending at exactly its cold-start number.
 *
 * A failure is the one thing a measureless run can still be judged on: a run that threw did not
 * do the work, whatever the work was worth. So the weight is the share of recorded runs that did
 * not fail, scaled by the neutral prior and never above it. A clean unmeasured run cannot raise
 * the weight, because an unmeasured success is unknown rather than good, and only a declared
 * metric carries an operation past neutral. No runs at all reads 0.5, which is what a cold start
 * read before this existed.
 *
 * It is a ratio over the whole record rather than a strike count so that recovery stays
 * reachable. Five failures put an operation at 0.14 and the floor refuses it; the deterministic
 * tiers still schedule it, and every clean run afterwards pulls the weight back toward neutral.
 * A transient fault costs the operation cycles rather than vetoing it for the life of the
 * substrate.
 */
export function executionWeight(runs: number, failed: number): number {
  const clean = Math.max(0, runs - failed);
  return (
    (NEUTRAL_EFFECTIVENESS_PRIOR * (clean + EXECUTION_PRIOR_RUNS)) / (runs + EXECUTION_PRIOR_RUNS)
  );
}

/**
 * The weight the blend multiplies confidence by, and the one place the two kinds of record meet.
 * A declared metric answers for itself, so its reading passes through untouched; an operation
 * with runs and no metric falls to the execution weight above; an operation with no row at all
 * gets the cold-start prior.
 */
export function proposalWeight(stats: OperationEffectiveness | undefined): number {
  if (stats === undefined) {
    return NEUTRAL_EFFECTIVENESS_PRIOR;
  }
  if (stats.effectiveness !== undefined) {
    return stats.effectiveness;
  }
  return executionWeight(stats.runs, stats.failed);
}

/** What the weight was read off, so a downgrade names its evidence and not only its number. */
function describeWeight(stats: OperationEffectiveness | undefined): string {
  if (stats === undefined) {
    return 'no record';
  }
  if (stats.effectiveness !== undefined) {
    return `effectiveness ${describeEffectiveness(stats.effectiveness)}`;
  }
  return `${String(stats.failed)} failures in ${String(stats.runs)} unscored runs`;
}

/**
 * The advisor's confidence, weighted by what the operation has actually done for the substrate.
 *
 * Confidence alone is not a discriminator: a single judge's confidence measures flat across
 * affirmative answers everywhere else in this system. The weight alone is not one either, since
 * most of the catalog has no scored metric and its weight can never clear neutral. The product
 * is: a confident recommendation for an operation whose runs have stopped improving anything, or
 * have stopped finishing, lands under the floor, and the same recommendation for one with a good
 * record clears it.
 */
export function blendedConfidence(confidence: number, weight: number | undefined): number {
  return confidence * (weight ?? NEUTRAL_EFFECTIVENESS_PRIOR);
}

/**
 * `rejected` is a proposal the loop will not act on and would not have acted on in any mode.
 * `downgraded` is one the loop keeps as a recommendation: the reasoning may be sound, but the
 * operation cannot be taken back, or its own record does not carry the confidence.
 */
export type Tier3Acceptance =
  /** Carries the candidate the gate already looked up, so no caller repeats the search. */
  | {
      readonly verdict: 'accepted';
      readonly candidate: OperationCandidate;
      readonly blended: number;
      /** The other half of the blend, so the ledger row re-derives the score from what it read. */
      readonly weight: number;
    }
  | {
      readonly verdict: 'downgraded';
      readonly reason: string;
      readonly blended?: number;
      readonly weight?: number;
    }
  | { readonly verdict: 'rejected'; readonly reason: string };

/**
 * The deterministic gates every proposal passes before anything runs, in order.
 *
 * A degraded snapshot is not one of them. Missing evidence blocks the actions that need that
 * evidence and nothing else: an operation whose reading came from a collector that failed
 * reports zero relevance for exactly that reason, and the relevance gate below is where that
 * lands. Refusing the whole consultation instead meant one broken collector stopped the loop
 * from thinking about the parts of the substrate it could still see.
 */
export function acceptTier3Proposal(
  proposal: Tier3Proposal,
  candidates: readonly OperationCandidate[],
  health: HealthSnapshot,
  acceptanceFloor: number,
): Tier3Acceptance {
  const candidate = candidates.find((entry) => entry.name === proposal.operation);
  if (candidate === undefined) {
    return { verdict: 'rejected', reason: 'the operation is not a candidate on this cycle' };
  }
  // Also where a degraded collector lands: an operation that cannot read its own demand reports
  // no work rather than a number taken from a fallback.
  if (candidate.relevance <= 0) {
    return { verdict: 'rejected', reason: 'the operation reports no work to do' };
  }

  if (TIER3_DENIED_OPERATIONS.includes(proposal.operation)) {
    return { verdict: 'downgraded', reason: 'the operation cannot be taken back' };
  }

  const stats = health.effectiveness.find((entry) => entry.name === proposal.operation);
  const weight = proposalWeight(stats);
  const blended = blendedConfidence(proposal.confidence, weight);
  if (blended < acceptanceFloor) {
    return {
      verdict: 'downgraded',
      reason:
        `confidence ${proposal.confidence.toFixed(2)} against ${describeWeight(stats)} ` +
        `blends to ${blended.toFixed(2)}, under ${acceptanceFloor.toFixed(2)}`,
      blended,
      weight,
    };
  }

  return { verdict: 'accepted', candidate, blended, weight };
}

/**
 * The advisor that recommends nothing: it writes what the deterministic tiers could not decide
 * and declines. It is what the engine falls back to when no model advisor is wired, so a loop
 * built without one still records how often the strategic layer was consulted.
 */
export function proposeOnlyAdvisor(logger: Logger): Tier3Advisor {
  return (request) => {
    const rationale = 'propose-only advisor, no model consulted';
    logger.info(
      {
        reason: request.reason,
        candidates: request.candidates.map((candidate) => candidate.name),
        vectorParity: request.health.graph.vectorParity,
        orphanShare: request.health.graph.orphanShare,
        queueDepth: request.health.queue.depth,
      },
      'introspection tier 3 consulted; propose-only, no operation selected',
    );
    return Promise.resolve({ status: 'declined', rationale });
  };
}
