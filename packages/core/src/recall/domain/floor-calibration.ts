import type { Vector } from '../../infrastructure/providers/types.js';
import type { AdmissionPolicy } from './admission.js';
import { cosineSimilarity } from './fusion.js';

/**
 * The measurement behind `recall.vectorAdmissionFloor`, kept as a function of two measured
 * distributions rather than of one. A floor calibrated on noise alone has no way to tell
 * "rejects unrelated text" from "rejects everything", which is the failure mode the
 * consultation flagged: a genuine match measured 0.631, close enough to a naive 0.60 floor
 * that the floor would have starved it.
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
  readonly unrelated: Distribution;
  readonly related: Distribution;
  readonly policy: AdmissionPolicy;
  /** How far either distribution may drift before the committed floor is judged stale. */
  readonly tolerance: number;
};

export type Separation = {
  readonly separated: boolean;
  /** The measured numbers, one line, so a failure reports evidence instead of a boolean. */
  readonly detail: string;
};

function round(value: number): string {
  return value.toFixed(3);
}

/**
 * Three claims, all of them about the committed floor rather than about an ideal one:
 * the distributions separate at all, the floor sits above the noise, and the floor sits
 * below what a genuine match scores. Tolerance is drift allowance, not slack in the claim —
 * embeddings are deterministic for a given model, so anything past it means the model
 * changed and the constant has to be re-measured.
 */
export function checkSeparation(input: SeparationInput): Separation {
  const floor = input.policy.vectorFloor;
  const overlaps = input.unrelated.p95 >= input.related.p05;
  const floorTooLow = input.unrelated.p95 >= floor + input.tolerance;
  const floorTooHigh = input.related.p05 <= floor - input.tolerance;

  const detail =
    `floor ${round(floor)} (corroboration ${round(input.policy.corroborationFloor)}), ` +
    `unrelated n=${String(input.unrelated.count)} p50 ${round(input.unrelated.p50)} ` +
    `p95 ${round(input.unrelated.p95)} max ${round(input.unrelated.max)}, ` +
    `related n=${String(input.related.count)} min ${round(input.related.min)} ` +
    `p05 ${round(input.related.p05)} p50 ${round(input.related.p50)}`;

  if (overlaps) {
    return {
      separated: false,
      detail: `${detail} — the distributions no longer separate at any floor; admission has to lean on corroboration and exact hits, and the committed constants need re-measuring`,
    };
  }
  if (floorTooLow) {
    return {
      separated: false,
      detail: `${detail} — the floor sits inside the noise band and admits unrelated text; re-measure and raise it`,
    };
  }
  if (floorTooHigh) {
    return {
      separated: false,
      detail: `${detail} — the floor sits above what genuine matches score and starves them; re-measure and lower it`,
    };
  }
  return { separated: true, detail };
}
