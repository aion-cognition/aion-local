import type { NominatedPair } from './entity-dedup-cascade.js';
import {
  statementWithContext,
  type JudgmentEvidenceOutcome,
  type JudgmentPair,
  type JudgmentSide,
} from '../../../evidence/application/judgment.js';
import { RENDERED_SIDE_OVERHEAD, utf16CodeUnits } from '../../../evidence/domain/budget.js';
import type { DedupEntityDetail } from '../../../infrastructure/graph/entity-dedup-queries.js';
import { describeEntityPairFacts, nameFormRelation } from '../../domain/entity-cascade.js';
import { parseTypeCounts } from '../../domain/entity-reconciliation.js';
import {
  describeEntityMergePair,
  type EntityMergePair,
  type EntityMergeSide,
} from '../entity-merge-judge.js';

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

/**
 * What an entity comparison asks the evidence seam for, from dedup and from proposal resolution
 * alike. The reserve counts the pair's own description beside the route's prompts, so the
 * excerpts the seam fits are the excerpts that still fit once both passes send the whole input.
 * Each side is located in captured text by its name and every alias it answers to.
 */
export function entityJudgmentPair(input: {
  readonly route: 'entity_merge' | 'proposal_resolution';
  readonly routeReserve: number;
  readonly pair: EntityMergePair;
  readonly nodeIds: readonly [string, string];
  readonly promptingSourceId?: string;
}): JudgmentPair {
  const { subject, candidate } = input.pair;
  return {
    route: input.route,
    reservedUnits:
      input.routeReserve +
      utf16CodeUnits(describeEntityMergePair(input.pair)) +
      2 * RENDERED_SIDE_OVERHEAD,
    use: 'entity_judgment',
    sides: [
      {
        nodeId: input.nodeIds[0],
        statement: subject.name,
        names: [subject.name, ...subject.aliases],
      },
      {
        nodeId: input.nodeIds[1],
        statement: candidate.name,
        names: [candidate.name, ...candidate.aliases],
      },
    ],
    ...(input.promptingSourceId === undefined
      ? {}
      : { promptingSourceId: input.promptingSourceId }),
  };
}

/** An excerpt side names itself; a side read whole is introduced as what the name rests on. */
function evidenceFact(name: string, side: JudgmentSide): string {
  return side.evidence === 'excerpts'
    ? side.renderedContext
    : statementWithContext(`${name} rests on:`, side);
}

/**
 * The pair a judge sees, carrying the captured text the resolver selected for each side and,
 * once, the captured text both sides share.
 */
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
      evidenceFact(pair.subject.name, left),
      evidenceFact(pair.candidate.name, right),
      ...(evidence.shared === undefined ? [] : [evidence.shared.renderedContext]),
    ],
  };
}
