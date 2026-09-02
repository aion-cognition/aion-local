import type { EntityPairSignals } from '../../infrastructure/graph/entity-signal-queries.js';
import type { NameFormRelation } from '../../infrastructure/sqlite/entity-merge-decisions.js';
import {
  isDeterministicRelation,
  nameFormRelation,
} from '../../reflection/domain/entity-cascade.js';

/**
 * Whether anything in the graph stands behind a pair a vector brought forward. Two entities
 * that arrived weeks apart and were never recalled together are exactly the pair no edge
 * joins, and a nearest-neighbour cosine is the only cheap way to find them at all. It is also
 * the one reading that may not decide: the fact-space distribution has no valley, so a cosine
 * high enough to nominate is not a cosine high enough to assert a relationship.
 *
 * So a nomination needs a second, and the seconds are readings of the store rather than of the
 * embedding space: the two were named in one episode, they hold a neighbour in common, or one
 * answers to a spelling of the other's name. Each is three-valued the way tier 2's evidence is:
 * it stands behind the pair, it says nothing, or it is absent because nothing was measured.
 * Nothing is averaged and no reading is combined with another, so a pair with a cosine and
 * nothing else leaves with no edge however high the cosine.
 */

export type SecondingSignal = 'shared_episode' | 'shared_neighbor' | 'name_overlap';

export type NominationEvidence = {
  /** Absent when the pair lost currency between the nomination and the evidence read. */
  readonly signals?: EntityPairSignals;
  /** The left identity's name and every spelling it answers to. */
  readonly leftForms: readonly string[];
  readonly rightForms: readonly string[];
};

/**
 * The strongest relation any spelling on one side holds to any spelling on the other. Aliases
 * are what an identity answers to, so a merge that absorbed "proposal_hygiene" leaves the
 * surviving node answering to it, and a name arm that read the display name alone would miss
 * the overlap the graph already recorded.
 */
const RELATION_STRENGTH: Readonly<Record<NameFormRelation, number>> = {
  fold: 3,
  squash: 2,
  bigram: 1,
  none: 0,
};

export function strongestNameRelation(
  leftForms: readonly string[],
  rightForms: readonly string[],
): NameFormRelation {
  let strongest: NameFormRelation = 'none';
  for (const left of leftForms) {
    for (const right of rightForms) {
      const relation = nameFormRelation(left, right);
      if (RELATION_STRENGTH[relation] > RELATION_STRENGTH[strongest]) {
        strongest = relation;
      }
    }
  }
  return strongest;
}

/**
 * Character overlap is deliberately not a second. `Postgres` scores past the identity
 * threshold against `PostgreSQL` and `gitlab-token` against `github-token`, so a bigram
 * relation joined to a high cosine is two readings of the same surface and no evidence at all.
 * Fold and squash equality are facts about the text: one string, spelled two ways.
 */
export function secondNomination(evidence: NominationEvidence): readonly SecondingSignal[] {
  const seconds: SecondingSignal[] = [];
  if ((evidence.signals?.sharedEpisodeCount ?? 0) > 0) {
    seconds.push('shared_episode');
  }
  if ((evidence.signals?.neighborOverlapCount ?? 0) > 0) {
    seconds.push('shared_neighbor');
  }
  if (isDeterministicRelation(strongestNameRelation(evidence.leftForms, evidence.rightForms))) {
    seconds.push('name_overlap');
  }
  return seconds;
}

const SECOND_RATIONALES: Readonly<Record<SecondingSignal, string>> = {
  shared_episode: 'both entities were named in the same episode',
  shared_neighbor: 'both entities are attached to a node in common',
  name_overlap: 'one entity answers to a spelling of the other name',
};

/** What the written edge says it stands on, so an undo can read the evidence that was wrong. */
export function discoveryRationale(seconds: readonly SecondingSignal[]): string {
  return seconds.map((second) => SECOND_RATIONALES[second]).join('; ');
}
