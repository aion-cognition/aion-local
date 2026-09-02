import {
  isDeterministicRelation,
  nameFormRelation,
} from '../../reflection/domain/entity-cascade.js';

/**
 * The tier-0 name rule, and the provenance the operation that acts on it stamps.
 *
 * `wouldAutoApply` answers the rule without touching the graph or the proposal it looks at, so
 * `aion stats` can count how many open proposals the policy would take. `merge_auto` runs the
 * same rule for real, armed by its own kill switch (`AION_AUTO_MERGE`); there is no review step
 * between the two.
 *
 * It asks the rule tier 0 runs: the name-form relation, deterministic on `fold` or `squash`.
 * Exact fold equality on its own stopped being a question the graph can answer yes to, because
 * since migration 003 two current entities cannot hold one folded name.
 *
 * It is the name arm only. Tier 0's other reading is alias equality, which needs the graph and
 * not a pair of names, so a pair this returns false for can still be swept.
 *
 * The relation is not the character-overlap rule in `entity-identity.ts` that finds merge
 * *candidates*. That rule scores "UserPromptSubmit" against "UserPromptSubmit hook" above its
 * own threshold and lands as `bigram`, which decides nothing here.
 */
export function wouldAutoApply(leftName: string, rightName: string): boolean {
  return isDeterministicRelation(nameFormRelation(leftName, rightName));
}

/**
 * Provenance stamped on the `SUPERSEDES` edge `merge_auto` writes. It is declared beside the
 * rule rather than in the operation that acts on it, because the two are the same policy: this
 * constant is what makes the acting half's lineage say a rule decided, never a person.
 */
export const AUTO_MERGE_METHOD = 'auto_merge';
