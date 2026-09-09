import type {
  AcceptedSourceSample,
  SourceReadiness,
} from '../../infrastructure/sqlite/probe-incidence.js';

/**
 * Whether a sampled source is one the probe may score.
 *
 * Two conditions, and neither substitutes for the other: the substrate has held the source long
 * enough for its pipeline to have finished, and the records say that pipeline did finish. World
 * time answers neither. A capture dated years ago and accepted this morning is not mature, and a
 * source nothing has processed is not a miss — it is a sample the probe has no business scoring.
 */

/** How long a source must have been held before its retrieval means anything. */
export const PROBE_ACCEPTANCE_AGE_MS = 24 * 60 * 60 * 1000;

export type SampleIneligibleReason =
  /** The archive proof behind this occurrence is missing or pinned, so acceptance is unproved. */
  | 'unverified_acceptance'
  | 'acceptance_clock_unreadable'
  | 'accepted_too_recently'
  /** Nothing has allocated and activated a processing generation for it. */
  | 'no_active_generation'
  /** A required pass is pending, retryable, pinned, or transferred and unfinished. */
  | 'processing_incomplete';

export type SampleEligibility =
  | { readonly status: 'eligible'; readonly acceptedAt: string }
  | { readonly status: 'ineligible'; readonly reason: SampleIneligibleReason };

export function sampleEligibility(
  sample: AcceptedSourceSample,
  readiness: SourceReadiness,
  now: Date,
): SampleEligibility {
  if (sample.verificationStatus !== 'verified') {
    return { status: 'ineligible', reason: 'unverified_acceptance' };
  }
  const accepted = Date.parse(sample.acceptedAt);
  if (Number.isNaN(accepted)) {
    return { status: 'ineligible', reason: 'acceptance_clock_unreadable' };
  }
  if (now.getTime() - accepted < PROBE_ACCEPTANCE_AGE_MS) {
    return { status: 'ineligible', reason: 'accepted_too_recently' };
  }
  if (readiness.generation === undefined) {
    return { status: 'ineligible', reason: 'no_active_generation' };
  }
  if (readiness.outstanding > 0 || readiness.unfinishedStages > 0) {
    return { status: 'ineligible', reason: 'processing_incomplete' };
  }
  return { status: 'eligible', acceptedAt: sample.acceptedAt };
}
