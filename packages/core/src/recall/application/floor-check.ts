import type { Provider } from '../../infrastructure/providers/types.js';
import {
  CALIBRATION_TOLERANCE,
  checkSeparation,
  describeDistribution,
  pairedCosines,
  type Separation,
} from '../domain/floor-calibration.js';
import type { AdmissionPolicy } from '../domain/admission.js';
import { RELATED_PAIRS, UNRELATED_PAIRS, type ScoredPair } from './floors.fixtures.js';

/**
 * The doctor's re-measurement of the committed floors: one embed call over a subset of the
 * calibration fixtures, on whatever model this machine actually has. It reports drift and
 * stops there — the committed constants stay the only runtime source of truth, and a floor
 * that moved per machine would make two installs disagree about what they remember.
 *
 * The full two-distribution calibration lives in `floor-calibration.int.test.ts`, which is
 * where a floor is re-committed. This is the field check that says go and look.
 */
export async function measureAdmissionFloor(
  provider: Provider,
  policy: AdmissionPolicy,
): Promise<Separation> {
  const pairs: readonly ScoredPair[] = [...UNRELATED_PAIRS, ...RELATED_PAIRS];
  const vectors = await provider.embed(pairs.flatMap((pair) => [pair.cue, pair.content]));
  const scores = pairedCosines(vectors);

  return checkSeparation({
    unrelated: describeDistribution(scores.slice(0, UNRELATED_PAIRS.length)),
    related: describeDistribution(scores.slice(UNRELATED_PAIRS.length)),
    policy,
    tolerance: CALIBRATION_TOLERANCE,
  });
}
