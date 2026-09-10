import type { ChunkRevisionDecision } from './chunk-revision.js';

/**
 * What a publication attempt's REASON says about what it cost and what it established.
 *
 * A scheduler reporting a run cannot read the status word for either question. `skipped` covers a
 * head that stands and a head nobody could establish; `failed` covers a refusal before the model
 * call and a generation that threw after one. Reporting the word instead of the reason says the
 * chunk is narrated when the substrate could not tell, and counts a provider call that never
 * happened — both in the one cost measurement this loop contributes.
 *
 * The vocabulary belongs to the lifecycle; this is the reading of it, in a module the reading's
 * consumer can import without depending on the lifecycle it is reporting on.
 */

type ChunkSkipReason = Extract<ChunkRevisionDecision, { action: 'skip' }>['reason'];

/**
 * The one skip reason that means the family's head stands and is current.
 *
 * Typed against the decision's own union, so renaming it there is a compile error here rather
 * than a silent reclassification of held work as settled work.
 */
export const STANDING_HEAD_REASON: ChunkSkipReason = 'head_current';

/**
 * The failure reasons that mean a provider was actually asked.
 *
 * Every other failure the publication returns happens before the call. This set has to move with
 * the lifecycle's failure vocabulary: a new PRE-call failure reason must not be added here, and a
 * new post-call one must.
 */
export const SYNTHESIS_ATTEMPTED_REASONS: readonly string[] = [
  'synthesis_failed',
  'no_grounded_sentence',
];

/**
 * The block reasons a member's own suppression state can clear.
 *
 * A block is not a delay: what clears it is the prerequisite it recorded, re-derived. These two
 * recorded that a member, or the correction a revision had to reground on, was proved forgotten —
 * so unforgetting it is exactly the change that makes the attempt runnable again.
 *
 * The other block reasons record other prerequisites: a member over the resolver's budget or a
 * render over the allowance clears on a recorded rendering-policy change, and an unreadable scope
 * clears when the scope becomes readable. Neither is derivable from the source states, and the
 * attempt record carries no note of the policy it ran under, so neither is reconsidered here.
 */
export const SUPPRESSION_BLOCK_REASONS: readonly string[] = [
  'no_admissible_input',
  'required_transition_evidence_suppressed',
];
