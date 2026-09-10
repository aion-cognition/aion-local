import type { HealthSnapshot, SealDemand } from './health.js';

/**
 * How much a reading calls for a seal run.
 *
 * The two scales are bound where the operation is constructed rather than read from the shipped
 * defaults inside the function: an operator who retunes the batch is saying what one run does, and
 * a demand score that kept dividing by the shipped number would rate the same backlog differently
 * from the run that drains it.
 */
export type SealRelevanceScales = {
  /** Publication attempts one run makes: the count the eligible groups are scored against. */
  readonly batch: number;
  /** The span a tail may stand for, which is the age one whole overdue group is worth. */
  readonly ageScaleMs: number;
};

/**
 * A prepared publication nobody settled is the whole reading on its own.
 *
 * It is not urgency for its own sake: while one publication is pending the guard admits no other,
 * so every writer on the substrate is behind it. Relevance makes the operation eligible for
 * selection and nothing more — the scheduler still decides, and no bucket carries a deadline.
 */
export const PENDING_PUBLICATION_RELEVANCE = 1;

export function sealRelevance(demand: SealDemand, scales: SealRelevanceScales): number {
  if (demand.pendingPublishedRepair === true) {
    return PENDING_PUBLICATION_RELEVANCE;
  }
  if (scales.batch <= 0 || scales.ageScaleMs <= 0) {
    return 0;
  }
  // Unavailable is not zero work; it is no reading. Scoring it as demand would run the operation
  // on a census nobody took, and scoring it as zero would be a claim the census did not make.
  // Either way the answer is the same number and the reason is not, which is what the diagnostic
  // on the demand carries.
  if (demand.availability !== 'measured' || demand.eligibleGroups === undefined) {
    return 0;
  }
  if (demand.eligibleGroups === 0) {
    return 0;
  }
  const byCount = demand.eligibleGroups / scales.batch;
  const byAge = (demand.oldestEligibleAgeMs ?? 0) / scales.ageScaleMs;
  return Math.min(1, Math.max(byCount, byAge));
}

export function narrativeSealRelevance(
  health: HealthSnapshot,
  scales: SealRelevanceScales,
): number {
  return sealRelevance(health.narrativeSeal, scales);
}
