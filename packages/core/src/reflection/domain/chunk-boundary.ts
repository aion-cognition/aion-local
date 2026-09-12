import { chunkMemberUnits, joinedUnits, type ChunkMemberText } from './chunk-render.js';

/**
 * When a session's unsealed tail becomes a chunk.
 *
 * The whole-session decision beside this one grows a single document forever: every close rewrites
 * the narrative over every episode the session ever held, so the cost of remembering a long session
 * is quadratic in its length. A chunk seals instead. Its membership freezes, its narrative is
 * written once, and the tail that follows it is somebody else's chunk.
 *
 * Admission is measured on the form the model is actually handed. The rule this replaced took a
 * member count and a per-member character cap and multiplied them, which admitted a set the render
 * then clipped: the seal believed it had shipped whole members and the coverage number it stored
 * said so. Here the running total is the rendered string's own length, envelope and separators
 * included, so a chunk that seals inside the allowance is a chunk that rendered inside it.
 */

/**
 * The rendered input one synthesis call is allowed, in UTF-16 code units.
 *
 * Defined here rather than derived from the episode knobs: the product of a member count and a
 * per-member clip is a statement about clipping, not about what a provider will read. The value
 * matches the order of the measured judge-route allowance on the same local model class and is
 * owed a measurement of its own against the narrative surface's prompt and answer reserve. C3
 * wires it, and `chunkMaxSpanMs` beside it, to the config surface.
 */
export const CHUNK_RENDERED_INPUT_ALLOWANCE = 16_384;

/** A bound on the count as well as the size: a thousand one-line members is not one reading. */
export const CHUNK_MAX_MEMBERS = 24;

/** A tail nobody added to still seals eventually, so a quiet session's last members are written. */
export const CHUNK_MAX_SPAN_MS = 24 * 60 * 60 * 1000;

export type ChunkBoundaryPolicy = {
  readonly renderedInputAllowance: number;
  readonly maxMembers: number;
  readonly maxSpanMs: number;
};

export const CHUNK_BOUNDARY_POLICY: ChunkBoundaryPolicy = {
  renderedInputAllowance: CHUNK_RENDERED_INPUT_ALLOWANCE,
  maxMembers: CHUNK_MAX_MEMBERS,
  maxSpanMs: CHUNK_MAX_SPAN_MS,
};

/**
 * What the evidence read said about one member of the tail.
 *
 * `suppressed` costs nothing to render because a proved-forgotten member reaches no model input;
 * it stays a member of the chunk it belongs to, and the revision records the gap. `isolated` is
 * the member no full render can admit alongside anything: it seals as a chunk of its own, and
 * whether that chunk publishes with a recorded gap or blocks is the publication's decision, not
 * this one.
 */
export type ChunkCandidateAdmission =
  | { readonly status: 'renderable' }
  | { readonly status: 'suppressed' }
  | {
      readonly status: 'isolated';
      readonly reason:
        'oversized_member' | 'member_over_resolver_budget' | 'member_evidence_unreadable';
    };

export type ChunkCandidate = {
  readonly sourceId: string;
  /** The live ingest order this member sits at, which is what freezes the member ordinals. */
  readonly captureOrderValue: string;
  /** World time: what the member says happened, which is not the same as when it arrived. */
  readonly occurredAt: Date;
  /**
   * When the substrate accepted it, which is the clock the span trigger ages on.
   *
   * Optional because a caller that has no acceptance record for a member falls back to world
   * time; every production caller reads it from the source record and supplies it.
   */
  readonly arrivalAt?: Date;
  readonly admission: ChunkCandidateAdmission;
  /** The member as the chunk renderer would place it. Absent for a member with no readable text. */
  readonly text?: ChunkMemberText;
};

export type ChunkSealTrigger =
  'rendered_input_allowance' | 'member_count' | 'max_span' | 'session_close' | 'isolated_member';

export type ChunkSealDecision =
  | {
      readonly action: 'seal';
      readonly trigger: ChunkSealTrigger;
      readonly reason: string;
      readonly members: readonly ChunkCandidate[];
      /** The lone member this chunk sealed around, when the trigger was its own size or state. */
      readonly isolated?: ChunkCandidate;
    }
  | { readonly action: 'wait'; readonly reason: string };

export type ChunkBoundaryInput = {
  readonly remainder: readonly ChunkCandidate[];
  readonly now: Date;
  /**
   * The session is ending, so its tail seals whatever size it reached. A small chunk at a close
   * is a small chunk; a tail that waits for a bound it will never reach is a session that is
   * never written down.
   */
  readonly sessionClosing: boolean;
  readonly policy?: ChunkBoundaryPolicy;
};

/** Capture order, then the source id, so two members recorded at one position still order. */
function inCaptureOrder(left: ChunkCandidate, right: ChunkCandidate): number {
  if (left.captureOrderValue !== right.captureOrderValue) {
    return left.captureOrderValue < right.captureOrderValue ? -1 : 1;
  }
  if (left.sourceId === right.sourceId) {
    return 0;
  }
  return left.sourceId < right.sourceId ? -1 : 1;
}

/** What this candidate costs the running render at the position it would take. */
function candidateUnits(candidate: ChunkCandidate, index: number): number {
  if (candidate.admission.status !== 'renderable' || candidate.text === undefined) {
    return 0;
  }
  return chunkMemberUnits(index, candidate.text);
}

function seal(
  trigger: ChunkSealTrigger,
  reason: string,
  members: readonly ChunkCandidate[],
  isolated?: ChunkCandidate,
): ChunkSealDecision {
  return {
    action: 'seal',
    trigger,
    reason,
    members,
    ...(isolated === undefined ? {} : { isolated }),
  };
}

/**
 * The clock the span trigger ages a tail on: ARRIVAL, not world time.
 *
 * The span measures elapsed capture and arrival age, never a backdated `occurredAt`, and the
 * scheduler that nominates a tail ages it the same way. Reading world time
 * here made the two disagree in both directions: a conversation about last year was permanently
 * overdue and never nominated, and a plan stated for next year was nominated as mature and then
 * refused by this decision forever. World time keeps every other job it has, the narrative's own
 * span and the calendar window among them; it is not what says a tail has been standing too long.
 *
 * One place, deliberately, so the two axes cannot drift apart again.
 */
function sealAge(candidate: ChunkCandidate): Date {
  return candidate.arrivalAt ?? candidate.occurredAt;
}

/** Which bound closed the chunk, said in the terms the manifest records against the seal. */
function fullReason(
  trigger: ChunkSealTrigger,
  members: number,
  policy: ChunkBoundaryPolicy,
): string {
  if (trigger === 'member_count') {
    return `${String(members)} members is the count bound`;
  }
  if (trigger === 'isolated_member') {
    return `the next member seals alone, so this one closes at ${String(members)} members`;
  }
  return `admitting the next member would exceed ${String(policy.renderedInputAllowance)} rendered units`;
}

/**
 * The seal rule: rendered-input admission, elapsed span, or the session's close.
 *
 * There is no minimum. A tail of one member does not seal on an ordinary pass, because no trigger
 * fires for it; it seals when the span runs out or when the session closes, which is what "a
 * below-minimum remainder at close still seals" means. A minimum that blocked either of those
 * would leave the session's last words permanently outside every narrative.
 */
export function decideChunkSeal(input: ChunkBoundaryInput): ChunkSealDecision {
  const policy = input.policy ?? CHUNK_BOUNDARY_POLICY;
  const ordered = [...input.remainder].sort(inCaptureOrder);
  const first = ordered[0];
  if (first === undefined) {
    return { action: 'wait', reason: 'the session has no unsealed members' };
  }

  if (first.admission.status === 'isolated') {
    return seal(
      'isolated_member',
      `${first.sourceId} seals alone: ${first.admission.reason}`,
      [first],
      first,
    );
  }

  const admitted: ChunkCandidate[] = [];
  const units: number[] = [];
  let full: ChunkSealTrigger | undefined;
  for (const candidate of ordered) {
    if (candidate.admission.status === 'isolated') {
      full = 'isolated_member';
      break;
    }
    if (admitted.length >= policy.maxMembers) {
      full = 'member_count';
      break;
    }
    // A suppressed member reaches no render, so it spends no allowance and takes no separator
    // with it. It still counts against the member bound: it is a member of this chunk.
    if (candidate.admission.status === 'suppressed') {
      admitted.push(candidate);
      continue;
    }
    const cost = candidateUnits(candidate, units.length);
    if (joinedUnits([...units, cost]) > policy.renderedInputAllowance) {
      full = 'rendered_input_allowance';
      break;
    }
    admitted.push(candidate);
    units.push(cost);
  }

  if (full !== undefined) {
    return seal(full, fullReason(full, admitted.length, policy), admitted);
  }

  if (input.sessionClosing) {
    return seal(
      'session_close',
      `the session closed over ${String(admitted.length)} unsealed members`,
      admitted,
    );
  }

  const elapsed = input.now.getTime() - sealAge(first).getTime();
  if (elapsed >= policy.maxSpanMs) {
    return seal('max_span', `the oldest unsealed member is ${String(elapsed)}ms old`, admitted);
  }

  return {
    action: 'wait',
    reason: `${String(admitted.length)} members are inside every bound and the session is open`,
  };
}
