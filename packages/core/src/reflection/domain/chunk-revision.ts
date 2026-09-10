import {
  chunkMemberUnits,
  joinedUnits,
  type ChunkMemberText,
  type SubmittedRange,
} from './chunk-render.js';
import type { RevisionCheck } from '../../evidence/application/dependencies.js';
import type {
  EvidenceDependency,
  EvidenceRevision,
} from '../../infrastructure/publication/preconditions.js';

/**
 * Whether a sealed chunk owes a revision, and what its inputs may be.
 *
 * Two questions, both decided from records rather than from prose. A chunk owes a revision when it
 * has no published head or when the head's dependency set no longer describes the substrate; what
 * that revision may be written from is decided by the evidence each member returned, and the two
 * ways an input can be short of complete are kept apart from every way it can be wrong.
 *
 * A GAP publishes. It is a proved, source-addressed statement about one member: the member is too
 * large to submit whole and the exact submitted ranges are recorded, or the member is proved
 * suppressed and its content reaches no model input. Either way the source stays pinned and its
 * healthy neighbours keep their own complete coverage.
 *
 * A BLOCK does not publish. Evidence nobody could read, a bound nobody could work inside, a gap
 * nothing scoped, an input set with nothing admissible left in it, and — the case that matters
 * most — a regrounding whose required transition evidence cannot be submitted. Omitting a
 * correction and publishing anyway would certify an uncorrected reading as current, which is the
 * one thing a narrative revision must never do.
 */

/** What one address's evidence read returned, in the terms this decision needs. */
export type ChunkEvidenceReading =
  | 'complete'
  /** Proved suppressed at the vantage the read was judged against. */
  | 'suppressed'
  /** Over the resolver's own per-call raw budget: AD-2's block class, never a gap. */
  | 'over_budget'
  /** Unresolved mapping, unreadable archive row, or a store that could not answer. */
  | 'unreadable'
  /** Neither proved present nor proved absent. Unknown establishes nothing. */
  | 'unproved';

export type ChunkMemberEvidence = {
  readonly sourceId: string;
  readonly reading: ChunkEvidenceReading;
  /** The rendered form, present exactly when the reading is complete. */
  readonly text?: ChunkMemberText;
};

export type CoverageGap =
  | {
      readonly reason: 'oversized_member';
      readonly sourceId: string;
      readonly submitted: readonly SubmittedRange[];
    }
  | { readonly reason: 'suppressed_member'; readonly sourceId: string };

export type ChunkBlockReason =
  | 'member_scope_census_missing'
  | 'member_evidence_missing'
  | 'member_over_resolver_budget'
  | 'no_admissible_input'
  | 'unscoped_coverage_gap'
  | 'required_transition_evidence_suppressed'
  | 'required_transition_evidence_unavailable';

export type ChunkInputPlan =
  | {
      readonly status: 'render';
      /** Frozen members whose raw text this revision submits, in their sealed order. */
      readonly members: readonly ChunkMemberText[];
      /** The changed evidence a regrounding must submit. Never joins the frozen membership. */
      readonly transition: readonly ChunkMemberText[];
      readonly gaps: readonly CoverageGap[];
      /** Named when this chunk sealed around a member no allowance carries whole. */
      readonly boundedPartialOf?: string;
      /** What that member's text may spend once every required whole input is reserved. */
      readonly boundedPartialAllowance?: number;
    }
  | {
      readonly status: 'block';
      readonly reason: ChunkBlockReason;
      readonly detail: string;
    };

export type ChunkInputRequest = {
  readonly members: readonly ChunkMemberEvidence[];
  /** The AD-1 required set, resolved through the resolver. Empty for a first publication. */
  readonly transition?: readonly ChunkMemberEvidence[];
  readonly allowance: number;
  /**
   * The single member this chunk sealed around whose full raw text the allowance cannot carry.
   * Present only where the resolver served the complete unit, which is what makes the gap a
   * statement about a submission rather than about a read that failed.
   */
  readonly oversizedMember?: string;
  /** The ranges the render would submit for that member, recorded on the gap. */
  readonly submittedRanges?: readonly SubmittedRange[];
  /**
   * Scopes the read needed and could not bind, as `<source>:<scope>` pairs.
   *
   * A revision published on an uncounted incoming-statement population is one no later correction
   * can invalidate: nothing was bound, so nothing can move. Holding is the conservative answer and
   * omitting the dependency was not.
   */
  readonly unprovedScopes?: readonly { readonly sourceId: string; readonly scope: string }[];
};

function block(reason: ChunkBlockReason, detail: string): ChunkInputPlan {
  return { status: 'block', reason, detail };
}

/**
 * A required transition source that cannot be submitted blocks the whole revision.
 *
 * Suppression is called out separately from every other failure because it is the one the forget
 * ruling names: a proved-suppressed correction may not be omitted and published around, and the
 * refusal has to say suppression rather than reporting it as an unreadable store.
 */
function transitionRefusal(transition: readonly ChunkMemberEvidence[]): ChunkInputPlan | undefined {
  const suppressed = transition.find((entry) => entry.reading === 'suppressed');
  if (suppressed !== undefined) {
    return block(
      'required_transition_evidence_suppressed',
      `${suppressed.sourceId} is required transition evidence and is proved suppressed`,
    );
  }
  const unavailable = transition.find(
    (entry) => entry.reading !== 'complete' || entry.text === undefined,
  );
  return unavailable === undefined
    ? undefined
    : block(
        'required_transition_evidence_unavailable',
        `${unavailable.sourceId} is required transition evidence and read ${unavailable.reading}`,
      );
}

/** Whichever refusal the member readings force, in the order the rulings decide them. */
function memberRefusal(members: readonly ChunkMemberEvidence[]): ChunkInputPlan | undefined {
  const overBudget = members.find((entry) => entry.reading === 'over_budget');
  if (overBudget !== undefined) {
    return block(
      'member_over_resolver_budget',
      `${overBudget.sourceId} is over the resolver's per-call raw budget, so no submission is bounded`,
    );
  }
  const unreadable = members.find((entry) => entry.reading === 'unreadable');
  if (unreadable !== undefined) {
    return block(
      'member_evidence_missing',
      `${unreadable.sourceId} has no readable evidence for its recorded membership`,
    );
  }
  // Unknown is not a proved gap, and only a proved source-addressed gap lets neighbours qualify
  // on their own coverage. An unscoped one stays a whole-revision refusal.
  const unproved = members.find((entry) => entry.reading === 'unproved');
  return unproved === undefined
    ? undefined
    : block(
        'unscoped_coverage_gap',
        `${unproved.sourceId} could be neither proved present nor proved suppressed`,
      );
}

/**
 * What this revision may submit, or why it may not publish at all.
 *
 * The bound is checked on the whole submission, members and transition evidence together: a
 * regrounding whose correction does not fit beside the raw members is a regrounding that cannot
 * be certified as current complete coverage, whatever it could have written without it.
 */
export function planChunkInput(request: ChunkInputRequest): ChunkInputPlan {
  const transition = request.transition ?? [];
  const transitionBlocked = transitionRefusal(transition);
  if (transitionBlocked !== undefined) {
    return transitionBlocked;
  }
  const memberBlocked = memberRefusal(request.members);
  if (memberBlocked !== undefined) {
    return memberBlocked;
  }
  const unproved = request.unprovedScopes ?? [];
  const firstUnproved = unproved[0];
  if (firstUnproved !== undefined) {
    return block(
      'member_scope_census_missing',
      `${String(unproved.length)} required scope(s) are uncounted, starting with ` +
        `${firstUnproved.scope} on ${firstUnproved.sourceId}`,
    );
  }

  const gaps: CoverageGap[] = [];
  const rendered: ChunkMemberText[] = [];
  for (const member of request.members) {
    if (member.reading === 'suppressed') {
      gaps.push({ reason: 'suppressed_member', sourceId: member.sourceId });
      continue;
    }
    if (member.text === undefined) {
      return block(
        'member_evidence_missing',
        `${member.sourceId} read complete and carried no text`,
      );
    }
    rendered.push(member.text);
  }

  if (rendered.length === 0) {
    return block(
      'no_admissible_input',
      'every member of this chunk is suppressed, so there is no permitted input',
    );
  }

  if (request.oversizedMember !== undefined) {
    gaps.push({
      reason: 'oversized_member',
      sourceId: request.oversizedMember,
      submitted: request.submittedRanges ?? [],
    });
  }

  const carried = transition.flatMap((entry) => (entry.text === undefined ? [] : [entry.text]));

  if (request.oversizedMember === undefined) {
    const units = [...rendered, ...carried].map((member, index) => chunkMemberUnits(index, member));
    if (joinedUnits(units) > request.allowance) {
      return block(
        'required_transition_evidence_unavailable',
        `the required transition evidence does not fit beside ${String(rendered.length)} raw members`,
      );
    }
    return {
      status: 'render',
      members: rendered,
      transition: carried,
      gaps,
    };
  }

  // The bounded member is placed first and everything required beside it is placed whole, so the
  // reservation is the whole render minus that member's own text: its envelope, every carried
  // input at the position it will take, and the separators between them. Selecting the bounded
  // subset against the FULL allowance was the defect — a required correction then pushed the
  // submission past the bound it was supposed to be chosen inside.
  const partial = rendered[0];
  if (partial === undefined) {
    return block('no_admissible_input', 'the bounded member is not among the rendered members');
  }
  const reserved = joinedUnits([
    chunkMemberUnits(0, { ...partial, text: '' }),
    ...carried.map((member, index) => chunkMemberUnits(index + 1, member)),
  ]);
  const boundedPartialAllowance = request.allowance - reserved;
  if (boundedPartialAllowance <= 0) {
    // Nothing of the member itself can be submitted. The signed answer is the no-input BLOCK, and
    // the one thing that may never happen instead is trimming the required evidence to make room.
    return block(
      'no_admissible_input',
      `no raw passage of ${partial.sourceId} fits beside the input this revision must submit`,
    );
  }

  return {
    status: 'render',
    members: rendered,
    transition: carried,
    gaps,
    boundedPartialOf: request.oversizedMember,
    boundedPartialAllowance,
  };
}

export type ChunkRevisionDecision =
  | {
      readonly action: 'synthesize';
      readonly reason: 'no_published_head' | 'head_invalidated';
      /** The dependencies that moved, which is the AD-1 required transition set's own origin. */
      readonly changed: readonly EvidenceDependency[];
    }
  | {
      readonly action: 'skip';
      readonly reason: 'head_current' | 'head_unverifiable' | 'head_uncovered';
    };

/**
 * Whether a sealed chunk owes a revision.
 *
 * Same-membership regeneration is always a new revision number, so this never compares prose: a
 * head that stands is one whose recorded dependency versions still read the same, and a head that
 * does not is regrounded. A head whose current versions cannot be read is neither — resynthesising
 * on an unreadable substrate would certify a reading nobody could take.
 */
export type ChunkHead = {
  readonly revisionNo: number;
  readonly nodeId: string;
  /** Absent when the head published without a recorded dependency set to fence on. */
  readonly evidence?: EvidenceRevision;
};

export function decideChunkRevision(
  head: ChunkHead | undefined,
  check: RevisionCheck | undefined,
): ChunkRevisionDecision {
  if (head === undefined) {
    return { action: 'synthesize', reason: 'no_published_head', changed: [] };
  }
  if (check === undefined) {
    // A published head carrying no recorded dependency set cannot be shown current, and the
    // absence is itself the answer rather than a licence to rewrite it.
    return { action: 'skip', reason: 'head_unverifiable' };
  }
  if (check.status === 'stale') {
    return { action: 'synthesize', reason: 'head_invalidated', changed: check.changed };
  }
  if (check.status === 'unverifiable') {
    return { action: 'skip', reason: 'head_unverifiable' };
  }
  return {
    action: 'skip',
    reason: check.status === 'uncovered' ? 'head_uncovered' : 'head_current',
  };
}

export type TransitionEndpoints = {
  /** Sources named directly by a changed dependency. */
  readonly sources: readonly string[];
  /** Nodes and relation scopes whose changed evidence the caller resolves to its sources. */
  readonly endpoints: readonly string[];
};

/**
 * Where the required transition evidence has to be looked for.
 *
 * A changed source dependency names its own source. A changed node or relation scope names an
 * endpoint whose evidence moved — the superseding claim, the correction's target — and the source
 * behind that change is external to the chunk by construction, which is exactly the evidence AD-1
 * says a regrounding must submit rather than reground around.
 */
export function transitionEndpoints(changed: readonly EvidenceDependency[]): TransitionEndpoints {
  const sources = new Set<string>();
  const endpoints = new Set<string>();
  for (const dependency of changed) {
    if (dependency.kind === 'source') {
      sources.add(dependency.id);
    } else {
      endpoints.add(dependency.id);
    }
  }
  return { sources: [...sources].sort(), endpoints: [...endpoints].sort() };
}
