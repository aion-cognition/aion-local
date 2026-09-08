import type { Driver } from 'neo4j-driver';

import {
  judgmentEvidenceFor,
  type JudgmentEvidenceOutcome,
  type JudgmentSideRequest,
} from '../../evidence/application/judgment.js';
import {
  loadEntityDedupDetails,
  type DedupEntityDetail,
} from '../../infrastructure/graph/entity-dedup-queries.js';
import { readEntityPairSignals } from '../../infrastructure/graph/entity-signal-queries.js';
import { loadEpisodeContext } from '../../infrastructure/graph/episode-context.js';
import { findSourceEpisodeId } from '../../infrastructure/graph/episode-supersession.js';
import {
  loadSessionEpisodes,
  type SessionEpisode,
} from '../../infrastructure/graph/narrative-queries.js';
import {
  fetchNodeEdges,
  fetchNodeProvenance,
  type NodeProvenance,
} from '../../infrastructure/graph/node-provenance.js';
import { findClaimSubjects, type ClaimSubject } from '../../infrastructure/graph/subject-family.js';
import { isFactNodeLabel } from '../../infrastructure/graph/supersession-queries.js';
import type { EntityMergeProposal } from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { ENTITY_MERGE_ROUTE_RESERVE } from '../../reflection/application/entity-merge-judge.js';
import type {
  EntityMergePair,
  EntityMergeSide,
} from '../../reflection/application/entity-merge-judge.js';
import { LIVE_SUPERSESSION_ROUTE_RESERVE } from '../../reflection/application/stages/supersession-judge.js';
import type { ContradictionPair } from '../../reflection/application/stages/supersession-judge.js';
import {
  describeEntityPairFacts,
  nameFormRelation,
} from '../../reflection/domain/entity-cascade.js';
import { parseTypeCounts } from '../../reflection/domain/entity-reconciliation.js';
import type { OperationContext } from '../domain/operation.js';

/**
 * What `proposal_resolution` puts in front of the judges, which is more than the pass that
 * filed the row was given. Every call runs at temperature 0, so re-asking the filing judge the
 * filing question returns the filing answer; the resolver earns a different one by reading
 * wider, and this is where that reading is assembled.
 *
 * Every read here already exists: the pair and the one-hop neighbourhood are what `aion why`
 * renders, the subject family and the session window are the reads a correction and a narrative
 * already take, and the merge facts are the tier-2 sentences the dedup cascade puts to its own
 * judge. Nothing new is queried and no Cypher lives here.
 */

/** How much of one evidence line reaches the prompt, so a long episode body cannot fill it. */
const EVIDENCE_LINE_CHARS = 240;

/** Subjects, session episodes, and neighbours each side of a pair contributes. */
const EVIDENCE_LINES = 6;

function clip(text: string): string {
  const stated = text.trim();
  if (stated.length <= EVIDENCE_LINE_CHARS) {
    return stated;
  }
  return `${stated.slice(0, EVIDENCE_LINE_CHARS)} (cut)`;
}

export type ClaimEvidence = {
  /** The fact label the judge is told the statement carries, as the filing pass names it. */
  readonly label: string;
  readonly statement: string;
  readonly subjects: readonly string[];
};

/**
 * The statement as written, then what stands around it. The first line is the claim itself and
 * everything under the heading is marked as context, because the question both passes answer is
 * about the statement rather than about the substrate around it.
 *
 * The session window is cut to its most recent episodes: a window that has to be cut keeps what
 * happened last, which is where a correction to an early claim would be.
 */
function renderStatement(
  node: NodeProvenance,
  subjects: readonly ClaimSubject[],
  sessionId: string | undefined,
  window: readonly SessionEpisode[],
): string {
  const observed =
    node.occurredAt === undefined ? 'at an unrecorded time' : node.occurredAt.toISOString();
  const lines = [
    node.content,
    '',
    'Context, which is not part of the statement:',
    `  observed ${observed}`,
  ];
  for (const subject of subjects.slice(0, EVIDENCE_LINES)) {
    const gloss = subject.gloss === undefined ? 'no description recorded' : clip(subject.gloss);
    lines.push(`  names ${subject.name}, currently described as: ${gloss}`);
  }
  if (sessionId !== undefined) {
    lines.push(`  from session ${sessionId}, which recorded in order:`);
    for (const episode of window.slice(-EVIDENCE_LINES)) {
      lines.push(`    ${clip(episode.summary ?? episode.text)}`);
    }
  }
  return lines.join('\n');
}

/**
 * What a resolution spends on its own prompts and answers before any evidence is rendered. It
 * runs both judgment shapes, so the reserve is the larger of the two.
 */
const RESOLUTION_ROUTE_RESERVE = Math.max(
  LIVE_SUPERSESSION_ROUTE_RESERVE,
  ENTITY_MERGE_ROUTE_RESERVE,
);

/**
 * Asked before either pass runs, so an abstention or an incomplete assembly costs no model call
 * and leaves the row open. A pinned row is not a dismissal: the queue keeps it, and an unforget
 * or a backfill is what makes it decidable.
 */
export async function judgmentEvidence(
  ctx: OperationContext,
  sides: readonly [JudgmentSideRequest, JudgmentSideRequest],
  use: 'claim_judgment' | 'entity_judgment',
): Promise<JudgmentEvidenceOutcome> {
  return judgmentEvidenceFor(ctx.evidence, {
    route: 'proposal_resolution',
    reservedUnits: RESOLUTION_ROUTE_RESERVE,
    use,
    sides,
  });
}

/**
 * Whether the evidence a judgment ran on still stands. A correction that arrived while the two
 * passes were answering is new evidence, and applying the old answer would close a claim on a
 * reading nobody holds any more.
 */
export function evidenceMoved(
  ctx: OperationContext,
  evidence: JudgmentEvidenceOutcome,
): string | undefined {
  if (evidence.status !== 'ready' || ctx.evidence === undefined) {
    return undefined;
  }
  const check = ctx.evidence.confirm(evidence.revision);
  return check.status === 'current' ? undefined : check.status;
}

/** What a row left open because its evidence could not support asking says in the log. */
export function withheldDetail(outcome: JudgmentEvidenceOutcome): string {
  return outcome.status === 'withheld'
    ? `required evidence does not support asking: ${outcome.withheld.kind}, ${outcome.withheld.reason}`
    : 'required evidence does not support asking';
}

/** `undefined` when the claim is unreadable, which leaves the row for the staleness backstop. */
export async function readClaimEvidence(
  driver: Driver,
  claimId: string,
  now: Date,
): Promise<ClaimEvidence | undefined> {
  const node = await fetchNodeProvenance(driver, claimId);
  if (node === undefined) {
    return undefined;
  }
  const subjects = await findClaimSubjects(driver, claimId);
  const episodeId = await findSourceEpisodeId(driver, claimId);
  const episode = episodeId === undefined ? undefined : await loadEpisodeContext(driver, episodeId);
  const window =
    episode === undefined ? [] : await loadSessionEpisodes(driver, episode.sessionId, now);
  return {
    label: node.labels.find(isFactNodeLabel) ?? 'claim',
    statement: renderStatement(node, subjects, episode?.sessionId, window),
    subjects: subjects.map((subject) => subject.name),
  };
}

/** The shared subject line is the names both claims carry, which is what the filing pass sent. */
export function contradictionPair(prior: ClaimEvidence, current: ClaimEvidence): ContradictionPair {
  const shared = prior.subjects.filter((name) => current.subjects.includes(name));
  return {
    priorLabel: prior.label,
    currentLabel: current.label,
    prior: prior.statement,
    current: current.statement,
    ...(shared.length === 0 ? {} : { sharedSubject: shared.join(', ') }),
  };
}

function judgeSide(detail: DedupEntityDetail): EntityMergeSide {
  const description = detail.description.trim();
  return {
    name: detail.name,
    aliases: detail.aliases,
    type: detail.type,
    typeCounts: parseTypeCounts(detail.typeCounts),
    ...(description.length === 0 ? {} : { description }),
  };
}

/** What each side touches, which the counted neighbour overlap on its own does not say. */
async function neighbourhoodFact(driver: Driver, entity: DedupEntityDetail): Promise<string> {
  const edges = await fetchNodeEdges(driver, entity.id);
  if (edges.length === 0) {
    return `${entity.name} is connected to nothing else in the graph.`;
  }
  const neighbours = edges
    .slice(0, EVIDENCE_LINES)
    .map((edge) => `${edge.type} ${clip(edge.otherContent)}`);
  return `${entity.name} is one hop from: ${neighbours.join('; ')}.`;
}

/** `undefined` when a side has lost currency, which is the staleness sweep's row, not this one's. */
export async function readMergeEvidence(
  driver: Driver,
  proposal: EntityMergeProposal,
): Promise<EntityMergePair | undefined> {
  const details = await loadEntityDedupDetails(driver, [proposal.leftId, proposal.rightId]);
  const byId = new Map(details.map((detail) => [detail.id, detail]));
  const left = byId.get(proposal.leftId);
  const right = byId.get(proposal.rightId);
  if (left?.current !== true || right?.current !== true) {
    return undefined;
  }
  const [signals] = await readEntityPairSignals(driver, [{ leftId: left.id, rightId: right.id }]);
  const facts = describeEntityPairFacts({
    leftName: left.name,
    rightName: right.name,
    relation: nameFormRelation(left.name, right.name),
    leftMentionCount: left.mentionCount,
    rightMentionCount: right.mentionCount,
    ...(signals === undefined ? {} : { signals }),
  });
  return {
    subject: judgeSide(left),
    candidate: judgeSide(right),
    facts: [
      ...facts,
      await neighbourhoodFact(driver, left),
      await neighbourhoodFact(driver, right),
    ],
  };
}
