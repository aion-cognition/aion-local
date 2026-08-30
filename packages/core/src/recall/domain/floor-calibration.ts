import type { AdmissionPolicy } from './admission.js';
import { cosineSimilarity } from './ranking.js';
import type { Vector } from '../../infrastructure/providers/types.js';

/**
 * The measurement behind `recall.vectorAdmissionFloor`, kept as a function of two measured
 * distributions rather than of one. A floor calibrated on noise alone has no way to tell
 * "rejects unrelated text" from "rejects everything": a genuine match measured 0.631, close
 * enough to a naive 0.60 floor that the floor would have starved it.
 *
 * Committed constants stay the only runtime source of truth. This module measures; nothing
 * here adjusts a floor, and the doctor check that calls it reports drift and stops there.
 */

/**
 * Drift allowance on a committed floor. Embeddings are deterministic for a given model and
 * text, so this absorbs a model point release and nothing else: past it, the constant was
 * calibrated against a different model than the one running.
 */
export const CALIBRATION_TOLERANCE = 0.03;

export type Distribution = {
  readonly count: number;
  readonly min: number;
  readonly p05: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
};

/** Linear interpolation between order statistics; the sample is small enough that the choice shows. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? Number.NaN;
  const high = sorted[upper] ?? Number.NaN;
  return low + (high - low) * (position - lower);
}

export function describeDistribution(scores: readonly number[]): Distribution {
  const sorted = [...scores].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p05: percentile(sorted, 0.05),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/** Cosine between every unordered pair of the set, which is what "mutually unrelated" measures. */
export function pairwiseCosines(vectors: readonly Vector[]): number[] {
  const scores: number[] = [];
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      scores.push(cosineSimilarity(vectors[left] ?? [], vectors[right] ?? []));
    }
  }
  return scores;
}

/** Cosine within each pair of a flattened cue/content list, in the order the pairs were embedded. */
export function pairedCosines(vectors: readonly Vector[]): number[] {
  const scores: number[] = [];
  for (let index = 0; index + 1 < vectors.length; index += 2) {
    scores.push(cosineSimilarity(vectors[index] ?? [], vectors[index + 1] ?? []));
  }
  return scores;
}

export type SeparationInput = {
  /** Raw cosines, not a summary: the share of genuine matches under the floor needs the sample. */
  readonly unrelatedScores: readonly number[];
  readonly relatedScores: readonly number[];
  readonly policy: AdmissionPolicy;
  /** How far either distribution may drift before the committed floor is judged stale. */
  readonly tolerance: number;
};

export type Separation = {
  readonly separated: boolean;
  /** The measured numbers, one line, so a failure reports evidence instead of a boolean. */
  readonly detail: string;
  readonly unrelated: Distribution;
  readonly related: Distribution;
  /** Fraction of `relatedScores` below the committed floor, which corroboration has to carry. */
  readonly relatedUnderFloor: number;
};

function round(value: number): string {
  return value.toFixed(3);
}

/**
 * The share of genuine matches the floor rejects on the vector leg alone. These are not
 * starved, since corroboration and exact lexical hits are what admit them, but past a point
 * the floor is carrying the wrong load and the number has to be visible before it gets there.
 */
export const MAX_RELATED_UNDER_FLOOR = 0.4;

/**
 * Two claims about the committed floor, plus one measurement reported either way.
 *
 * The floor must sit above what unrelated text scores, with drift allowance: this is the only
 * claim a floor can make on its own, and it is the one the off-topic packs violated.
 * It must also sit below what a typical genuine match scores, judged at the related median
 * rather than at a tail order statistic. The tails of the two distributions overlap on this
 * model, so a floor pinned to `related.p05` is pinned to noise.
 *
 * Overlap itself is not a failure. Where the distributions cross, the answer is corroboration
 * and exact hits, never a lower floor: a floor dropped into the band admits unrelated text on
 * one leg, which is the failure this whole gate exists to stop. What is reported is how much of
 * the related distribution corroboration is being asked to carry.
 *
 * The corroboration floor gets the same claim as the admission floor and for the same reason.
 * It is a lower bar, not a suspended one: two measurements that are both inside the noise band
 * are one distribution sampled twice, and letting them vouch for each other reproduces the
 * failure one notch down. That is what the surviving off-topic items were, every one
 * of them under the admission floor on its own evidence.
 *
 * Tolerance is drift allowance, not slack in a claim: embeddings are deterministic for a given
 * model, so anything past it means the model changed and the constant has to be re-measured.
 */
export function checkSeparation(input: SeparationInput): Separation {
  const floor = input.policy.vectorFloor;
  const unrelated = describeDistribution(input.unrelatedScores);
  const related = describeDistribution(input.relatedScores);
  const under = input.relatedScores.filter((score) => score < floor).length;
  const relatedUnderFloor =
    input.relatedScores.length === 0 ? 0 : under / input.relatedScores.length;

  const floorTooLow = unrelated.p95 >= floor + input.tolerance;
  const floorTooHigh = related.p50 <= floor - input.tolerance;
  const corroborationTooLow = unrelated.p95 >= input.policy.corroborationFloor + input.tolerance;

  const detail =
    `floor ${round(floor)} (corroboration ${round(input.policy.corroborationFloor)}), ` +
    `unrelated n=${String(unrelated.count)} p50 ${round(unrelated.p50)} ` +
    `p95 ${round(unrelated.p95)} max ${round(unrelated.max)}, ` +
    `related n=${String(related.count)} min ${round(related.min)} ` +
    `p05 ${round(related.p05)} p50 ${round(related.p50)}, ` +
    `${(relatedUnderFloor * 100).toFixed(0)}% of genuine matches under the floor and carried by corroboration`;

  const measured = { unrelated, related, relatedUnderFloor };

  if (floorTooLow) {
    return {
      ...measured,
      separated: false,
      detail: `${detail} — the floor sits inside the noise band and admits unrelated text; re-measure and raise it`,
    };
  }
  if (floorTooHigh) {
    return {
      ...measured,
      separated: false,
      detail: `${detail} — the floor sits above what a typical genuine match scores; re-measure and lower it`,
    };
  }
  if (corroborationTooLow) {
    return {
      ...measured,
      separated: false,
      detail: `${detail} — the corroboration floor sits inside the noise band, so two readings of the same noise admit each other; re-measure and raise it`,
    };
  }
  if (relatedUnderFloor > MAX_RELATED_UNDER_FLOOR) {
    return {
      ...measured,
      separated: false,
      detail: `${detail} — corroboration is carrying more of the genuine matches than the floor is; re-measure both distributions`,
    };
  }
  return { ...measured, separated: true, detail };
}
