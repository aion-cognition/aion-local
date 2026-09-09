import type { AcceptedSourceSample } from '../../infrastructure/sqlite/probe-incidence.js';
import {
  readinessSupportsSampling,
  type ProcessingReadiness,
} from '../../reflection/domain/readiness.js';

/**
 * Whether a sampled source is one the probe may score.
 *
 * Two conditions, and neither substitutes for the other: the substrate has held the source long
 * enough for its pipeline to have finished, and the records say that pipeline did finish. World
 * time answers neither. A capture dated years ago and accepted this morning is not mature, and a
 * source nothing has processed is not a miss — it is a sample the probe has no business scoring.
 *
 * The second condition is not decided here. `readinessSupportsSampling` answers it against the
 * stage set the source's OWN accepted policy required, which is the only thing that can tell an
 * inventory nobody wrote from one that owes nothing. A rule counting rows beside that seam would
 * be a second definition of the same question, and the two would drift.
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
  /** A required pass is pending, retryable, pinned, dead-lettered or transferred and unfinished. */
  | 'processing_incomplete'
  /** The records cannot say what the pass was: a stage the policy required has no row at all. */
  | 'processing_unproved';

export type SampleEligibility =
  | { readonly status: 'eligible'; readonly acceptedAt: string }
  | {
      readonly status: 'ineligible';
      readonly reason: SampleIneligibleReason;
      /** What the records said, so a skip is reportable rather than merely counted. */
      readonly detail?: readonly string[];
    };

/**
 * Which ineligible answer an unaccountable pass deserves.
 *
 * `unknown` covers two different situations and they are not the same skip. No active generation
 * means nothing has ever claimed this source. Anything else unknown means a generation exists and
 * its inventory cannot be read against the policy it was accepted under.
 */
function unaccountable(readiness: ProcessingReadiness): SampleIneligibleReason {
  return readiness.processingGeneration === undefined
    ? 'no_active_generation'
    : 'processing_unproved';
}

export function sampleEligibility(
  sample: AcceptedSourceSample,
  readiness: ProcessingReadiness,
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
  if (!readinessSupportsSampling(readiness)) {
    return {
      status: 'ineligible',
      reason:
        readiness.completeness === 'incomplete'
          ? 'processing_incomplete'
          : unaccountable(readiness),
      detail: readiness.reasons,
    };
  }
  return { status: 'eligible', acceptedAt: sample.acceptedAt };
}
