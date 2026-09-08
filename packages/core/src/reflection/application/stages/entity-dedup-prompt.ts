import type { NominatedPair } from './entity-dedup-cascade.js';
import {
  statementWithContext,
  type JudgmentEvidenceOutcome,
} from '../../../evidence/application/judgment.js';
import type { DedupEntityDetail } from '../../../infrastructure/graph/entity-dedup-queries.js';
import { describeEntityPairFacts, nameFormRelation } from '../../domain/entity-cascade.js';
import { parseTypeCounts } from '../../domain/entity-reconciliation.js';
import type { EntityMergePair, EntityMergeSide } from '../entity-merge-judge.js';

/**
 * What the two entity judge passes are shown, built once so both passes argue the same evidence.
 * Split out of the stage to keep that file inside the repository's line cap.
 */

function toJudgeSide(detail: DedupEntityDetail): EntityMergeSide {
  const description = detail.description.trim();
  return {
    name: detail.name,
    aliases: detail.aliases,
    type: detail.type,
    typeCounts: parseTypeCounts(detail.typeCounts),
    ...(description.length === 0 ? {} : { description }),
  };
}

export function buildJudgePair(
  left: DedupEntityDetail,
  right: DedupEntityDetail,
  pair: NominatedPair,
): EntityMergePair {
  return {
    subject: toJudgeSide(left),
    candidate: toJudgeSide(right),
    facts: describeEntityPairFacts({
      leftName: left.name,
      rightName: right.name,
      relation: nameFormRelation(left.name, right.name),
      leftMentionCount: left.mentionCount,
      rightMentionCount: right.mentionCount,
      ...(pair.signals === undefined ? {} : { signals: pair.signals }),
    }),
  };
}

/** The pair a judge sees, carrying whatever sources the resolver reserved for each side. */
export function withEvidence(
  pair: EntityMergePair,
  evidence: JudgmentEvidenceOutcome,
): EntityMergePair {
  if (evidence.status !== 'ready') {
    return pair;
  }
  const [left, right] = evidence.sides;
  return {
    ...pair,
    facts: [
      ...pair.facts,
      statementWithContext(`${pair.subject.name} rests on:`, left),
      statementWithContext(`${pair.candidate.name} rests on:`, right),
    ],
  };
}
