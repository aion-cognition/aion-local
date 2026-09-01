import { nameDigitsMatch, nameFormMatches } from './entity-identity.js';
import { squashName } from './entity-reconciliation.js';
import { foldName } from '../../infrastructure/providers/unicode-fold.js';
import type { NameFormRelation } from '../../infrastructure/sqlite/entity-merge-decisions.js';

/**
 * How two entity names relate, as one value the whole cascade reads. Tier 0 acts on the two
 * strongest relations without asking a model; every other tier carries the relation into the
 * evidence a judge sees, where it is one fact among several rather than a gate.
 *
 * The relations are ordered by how much they claim. `fold` is the same name spelled two ways.
 * `squash` is the same name spelled with different separators, which is evidence and not proof:
 * `re-mark` and `remark` reach one squashed key and are two words. `bigram` is character
 * overlap past the identity threshold, which is where `gitlab-token` scored 0.9109 against
 * `github-token`, so it never decides anything on its own.
 */

/**
 * The two relations a merge may take without a model call. Both mean the names are one string
 * once spelling is set aside, which is a fact about the text rather than a judgment about the
 * world.
 */
const DETERMINISTIC_RELATIONS: readonly NameFormRelation[] = ['fold', 'squash'];

export function isDeterministicRelation(relation: NameFormRelation): boolean {
  return DETERMINISTIC_RELATIONS.includes(relation);
}

/**
 * The digit guard rides on the squash arm as well as the bigram one. The squashed key strips
 * separators and keeps digits, so two names reaching one key already carry the same digits and
 * the check cannot fire today. It is here so the rule belongs to the tier rather than to the
 * key: the day the key changes, `beta-episode-1` and `beta-episode-2` still do not auto-merge.
 */
export function nameFormRelation(left: string, right: string): NameFormRelation {
  const foldedLeft = foldName(left);
  const foldedRight = foldName(right);
  if (foldedLeft.length === 0 || foldedRight.length === 0) {
    return 'none';
  }
  if (foldedLeft === foldedRight) {
    return 'fold';
  }
  if (
    squashName(foldedLeft) === squashName(foldedRight) &&
    nameDigitsMatch(foldedLeft, foldedRight)
  ) {
    return 'squash';
  }
  if (nameFormMatches(foldedLeft, foldedRight)) {
    return 'bigram';
  }
  return 'none';
}
