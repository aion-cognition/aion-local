import type { AdmissionReport } from './admission.js';

/**
 * What an empty pack says about itself. The copy lives apart from assembly because it is prose
 * a reader acts on, and the wrong sentence sends them to ask again for something the wire had
 * already withheld on purpose.
 */

const EMPTY_PACK_BODY = 'No memories matched this query.';

/**
 * The three other ways a pack empties, all of them the wire cutting matches the substrate did
 * hold. Saying "no memories matched" for any of them would be false, and it is the one sentence
 * a reader would act on by asking again.
 */
const EMPTY_AFTER_REPEATS_BODY = 'This session already holds every memory this query matched.';

const EMPTY_AFTER_OWN_BODY = "Every memory this query matched came from this session's own record.";

const EMPTY_AFTER_BOTH_BODY =
  'This session already holds every memory this query matched, from earlier recalls and from ' +
  'its own record.';

function emptyOpening(repeats: number, own: number): string {
  if (repeats > 0 && own > 0) {
    return EMPTY_AFTER_BOTH_BODY;
  }
  if (own > 0) {
    return EMPTY_AFTER_OWN_BODY;
  }
  if (repeats > 0) {
    return EMPTY_AFTER_REPEATS_BODY;
  }
  return EMPTY_PACK_BODY;
}

/**
 * What an empty pack says about itself, in the rendered text rather than only in metadata.
 *
 * The sentence alone reads the same for three states that call for three different responses:
 * a substrate with nothing in it, a floor that judged real candidates and refused all of them,
 * and a set of candidates nothing could measure at all. The counts are in metadata already;
 * this is the copy that reaches a client reading only the rendered block, which is also the
 * client most likely to read a note about a truncated spread as the reason the pack is empty.
 */
export function emptyPackBody(report: AdmissionReport, repeats: number, own: number): string {
  const opening = emptyOpening(repeats, own);
  if (report.considered === 0) {
    return `${opening} Nothing reached the admission gate.`;
  }

  const clauses: string[] = [];
  if (report.droppedBelowFloor > 0) {
    clauses.push(
      `${String(report.droppedBelowFloor)} measured under the ${report.policy.vectorFloor.toFixed(2)} floor`,
    );
  }
  if (report.droppedUnmeasured > 0) {
    clauses.push(`${String(report.droppedUnmeasured)} that nothing measured against it`);
  }
  if (clauses.length === 0) {
    return opening;
  }
  return `${opening} Of ${String(report.considered)} candidates: ${clauses.join(', ')}.`;
}
