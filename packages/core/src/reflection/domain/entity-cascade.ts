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

const RELATION_SENTENCES: Readonly<Record<NameFormRelation, string>> = {
  fold: 'The two names are one string once case and spacing are set aside.',
  squash: 'The two names differ only in the separators they are spelled with.',
  bigram:
    'The two names share most of their characters but are not one string. Names can overlap ' +
    'this far and still belong to two different things.',
  none: 'The two names have no measured relation to each other.',
};

export type EntityPairFactInput = {
  readonly leftName: string;
  readonly rightName: string;
  readonly relation: NameFormRelation;
  readonly leftMentionCount: number;
  readonly rightMentionCount: number;
  /** Absent when the pair signal read returned nothing, which is not the same as returning zero. */
  readonly signals?: {
    readonly sharedEpisodeCount: number;
    readonly neighborOverlapCount: number;
    readonly temporalGapDays?: number;
    readonly leftEpisodeCount: number;
    readonly rightEpisodeCount: number;
  };
};

function plural(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * Tier 2's evidence as sentences a judge can read, one fact per sentence, nothing averaged and
 * nothing combined. Absence is stated as absence: a pair nobody could measure says so, rather
 * than reporting a zero that reads as evidence against the merge.
 *
 * The nominating cosine is deliberately not in here. It belongs in the decision record, where
 * it is a measurement; in a prompt it is a number inviting the judge to treat a threshold as
 * the answer, and the whole point of the tier is that the vector does not decide.
 */
export function describeEntityPairFacts(input: EntityPairFactInput): string[] {
  const facts = [RELATION_SENTENCES[input.relation]];
  const { signals } = input;
  if (signals === undefined) {
    facts.push('Nothing about the two together could be measured in the graph.');
    return facts;
  }

  const union = signals.leftEpisodeCount + signals.rightEpisodeCount - signals.sharedEpisodeCount;
  facts.push(
    signals.sharedEpisodeCount === 0
      ? 'No episode mentions both of them.'
      : `They are mentioned together in ${plural(signals.sharedEpisodeCount, 'episode')} of the ` +
          `${plural(union, 'episode')} that mention either.`,
  );
  facts.push(
    signals.neighborOverlapCount === 0
      ? 'They are connected to none of the same nodes.'
      : `They are both connected to ${plural(signals.neighborOverlapCount, 'other node')}.`,
  );
  facts.push(
    signals.temporalGapDays === undefined
      ? 'Neither has a dated mention, so nothing says how far apart they were seen.'
      : `Their closest mentions are ${signals.temporalGapDays.toFixed(1)} days apart.`,
  );
  facts.push(
    `${input.leftName} is mentioned in ${plural(input.leftMentionCount, 'episode')}, ` +
      `${input.rightName} in ${plural(input.rightMentionCount, 'episode')}.`,
  );
  return facts;
}
