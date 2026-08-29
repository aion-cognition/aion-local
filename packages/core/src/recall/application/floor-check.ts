import type { Provider } from '../../infrastructure/providers/types.js';
import {
  CALIBRATION_TOLERANCE,
  checkSeparation,
  pairedCosines,
  pairwiseCosines,
  type Separation,
} from '../domain/floor-calibration.js';
import type { AdmissionPolicy } from '../domain/admission.js';
import {
  RELATED_PAIRS,
  UNRELATED_PAIRS,
  UNRELATED_SENTENCES,
  type ScoredPair,
} from './floors.fixtures.js';

/**
 * The doctor's re-measurement of the committed floors, on whatever model this machine actually
 * has. It reports drift and stops there: the committed constants stay the only runtime source
 * of truth, and a floor that moved per machine would make two installs disagree about what they
 * remember.
 *
 * It measures the same two distributions the committed calibration does, including the
 * mutually-unrelated sentence set. Measuring a narrower noise sample here would let the doctor
 * report `ok` in a state where the committed test fails, which is the one thing a field check
 * must never do.
 *
 * `floor-calibration.int.test.ts` is where a floor is re-committed. This is the check that says
 * go and look.
 */
export async function measureAdmissionFloor(
  provider: Provider,
  policy: AdmissionPolicy,
): Promise<Separation> {
  const pairs: readonly ScoredPair[] = [...UNRELATED_PAIRS, ...RELATED_PAIRS];
  const vectors = await provider.embed([
    ...pairs.flatMap((pair) => [pair.cue, pair.content]),
    ...UNRELATED_SENTENCES,
  ]);
  const paired = pairedCosines(vectors.slice(0, pairs.length * 2));
  const mutual = pairwiseCosines(vectors.slice(pairs.length * 2));

  return checkSeparation({
    unrelatedScores: [...paired.slice(0, UNRELATED_PAIRS.length), ...mutual],
    relatedScores: paired.slice(UNRELATED_PAIRS.length),
    policy,
    tolerance: CALIBRATION_TOLERANCE,
  });
}
