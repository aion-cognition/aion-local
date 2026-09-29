import type { AssessmentReport, Degradation, PackTruncation } from '@aion/protocol';

import type { AdmissionReport } from './admission.js';

/**
 * What a pack says about itself: the honesty line at the top, and what an empty one says in
 * place of memories. The copy lives apart from assembly because it is prose a reader acts on,
 * and the wrong sentence sends them to ask again for something the wire had already withheld
 * on purpose.
 */

const STAGE_PHRASES: Readonly<Record<Degradation['stage'], string>> = {
  cues: 'cue extraction',
  embed: 'embedding',
  graph: 'graph reads',
  assessment: 'memory assessment, so this is the retrieval ranking',
};

/** Long enough for a caveat, short enough that the model cannot write the pack's text for it. */
export const MAX_ASSESSOR_NOTE_CHARS = 240;

const TRUNCATION_PHRASES: Readonly<Record<PackTruncation, string>> = {
  activation_budget: 'spread truncated on the activation budget',
};

export type HonestyInput = {
  readonly degraded?: readonly Degradation[];
  readonly truncated?: PackTruncation;
  readonly pendingEnrichment?: number;
  /**
   * Why the obligation count is absent, when it is absent because nothing could count it. An
   * omitted field alone reads the same as a healthy session with nothing pending, so the reason
   * is said out loud instead.
   */
  readonly obligationCensusGap?: string;
  readonly repeats: number;
  readonly own: number;
  readonly duplicates: number;
  /** What the recall model said about its own selection, when it said anything. */
  readonly assessorNote?: string;
};

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : many}`;
}

/**
 * The honesty signals as one plain line at the top of the rendered block. A client reading
 * only `content` from an MCP tool result sees the rendered text and nothing else, so a pack
 * whose metadata says "degraded" reads to that client exactly like a confident answer, which
 * already cost one full baseline run. The same signals stay in `metadata` for a structured
 * consumer; this is the copy that reaches everyone.
 *
 * The three subtractions are named apart, because they withhold for three different reasons and
 * a reader deciding whether to ask again needs to know which one it is looking at.
 */
export function honestyNote(input: HonestyInput): string | undefined {
  const clauses: string[] = [];
  for (const rung of input.degraded ?? []) {
    clauses.push(`degraded ${STAGE_PHRASES[rung.stage]} (${rung.reason})`);
  }
  if (input.truncated !== undefined) {
    clauses.push(TRUNCATION_PHRASES[input.truncated]);
  }
  const pending = input.pendingEnrichment ?? 0;
  if (pending > 0) {
    clauses.push(`${plural(pending, 'recent episode')} not yet enriched`);
  }
  if (input.obligationCensusGap !== undefined) {
    clauses.push(`unenriched-episode count unavailable (${input.obligationCensusGap})`);
  }
  if (input.repeats > 0) {
    clauses.push(`${plural(input.repeats, 'item')} already served this session, unchanged`);
  }
  if (input.own > 0) {
    clauses.push(`${plural(input.own, 'item')} from this session's own turns`);
  }
  if (input.duplicates > 0) {
    clauses.push(`${plural(input.duplicates, 'item')} restating one already served here`);
  }
  if (input.assessorNote !== undefined) {
    clauses.push(`assessment says: ${input.assessorNote}`);
  }
  if (clauses.length === 0) {
    return undefined;
  }
  return `note: ${clauses.join('; ')}`;
}

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
 * What a pack says above memories that reached it without matching the query: a resonant
 * discovery or a triggered intention, and nothing the query matched beside them. Without it
 * those items read as the answer, because the sentence that says the query went unanswered
 * printed only on a pack with nothing in it.
 */
export function unansweredBody(emptyBody: string): string {
  return `${emptyBody} What follows reached the pack another way, and each item names how.`;
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
export function emptyPackBody(
  report: AdmissionReport,
  repeats: number,
  own: number,
  assessment?: AssessmentReport,
): string {
  // A judgment rather than a miss: the model was shown what retrieval found and chose none of it.
  if (assessment?.outcome === 'selected' && assessment.selected === 0 && assessment.shown > 0) {
    return (
      `Retrieval found ${plural(assessment.shown, 'candidate memory', 'candidate memories')}; ` +
      'the assessment judged none of them useful here.'
    );
  }
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
