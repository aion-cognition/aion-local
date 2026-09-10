import type { ChunkBlockReason, ChunkRevisionDecision } from './chunk-revision.js';

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
 * render over the allowance clears on a recorded rendering-policy change, which is not derivable
 * from the source states, and the attempt record carries no note of the policy it ran under.
 *
 * `no_admissible_input` is in this set and is NOT evidence of a suppression. A chunk answers it
 * when every member is suppressed and equally when no member fits the allowance, so the reason
 * names a class and the records have to name the cause. Membership here only puts the attempt in
 * front of the prerequisite test.
 */
export const SUPPRESSION_BLOCK_REASONS: readonly string[] = [
  'no_admissible_input',
  'required_transition_evidence_suppressed',
];

/**
 * The block whose prerequisite is a COUNT rather than a state.
 *
 * A revision refuses when a member's incoming-statement scope is uncounted, because an uncounted
 * scope is not a proved-empty one and coverage cannot be certified over it. What clears it is the
 * census being established for those scopes — a different question from suppression, asked of a
 * different record, so it gets its own test rather than sharing the suppression one. Typed against
 * the lifecycle's own union: renaming the reason there is a compile error here.
 */
export const CENSUS_BLOCK_REASON: ChunkBlockReason = 'member_scope_census_missing';

/**
 * The blocks whose prerequisite is a BOUND rather than a state or a count.
 *
 * Both are refusals about how much an attempt was allowed to spend, and both clear on one thing:
 * the bounds in force differing from the bounds the refusal recorded. `no_admissible_input` is in
 * this set and in the suppression one, because the reason is shared and the cause is not — each
 * test asks its own question of the records, and an attempt neither can answer stays blocked.
 */
export const POLICY_BLOCK_REASONS: readonly ChunkBlockReason[] = [
  'no_admissible_input',
  'member_over_resolver_budget',
];
