import type { FusedItem } from './fusion.js';
import { cosineSimilarity } from './ranking.js';
import type { TriggerableIntention } from '../../infrastructure/graph/intention-queries.js';
import type { SeedCandidate } from '../../infrastructure/graph/seed-queries.js';
import type { Vector } from '../../infrastructure/providers/types.js';

/**
 * Whether a standing intention has come round again, decided from what the run already holds.
 * Nothing here reads the graph, embeds anything, or asks a model: recall spends its one
 * generation call on cue extraction, and an intention that needed a second one would be a
 * standing cost on every recall for a bucket that is usually empty.
 *
 * The three conditions answer three different questions, and an intention fires on whichever it
 * carries. The subject entity is the entity trigger and needs no stored field of its own; the
 * date is the one the episode named; the situation is the source episode's content vector
 * against the centroid the second pass already computed.
 */

/** How an intention explains itself in the pack, in place of a retrieval method. */
export const INTENTION_TRIGGER_METHOD = 'intention_trigger';

export type IntentionTriggerKind = 'entity' | 'temporal' | 'situation';

/** What the pack prints as the path, so a reader knows which condition brought the item back. */
export const INTENTION_TRIGGER_PATHS: Readonly<Record<IntentionTriggerKind, string>> = {
  entity: 'the thing it is about is in play',
  temporal: 'the date it named has passed',
  situation: 'this moment resembles the one it was filed in',
};

/**
 * Narrowest condition first. An entity trigger fired because the subject itself is in the
 * activated set, a temporal one because a clock passed and nothing about this recall, and a
 * situation one on a resemblance between two neighborhoods. Two intentions under one kind keep
 * the order they were read in, which is newest first.
 */
const KIND_ORDER: readonly IntentionTriggerKind[] = ['entity', 'temporal', 'situation'];

export type IntentionTriggerContext = {
  /** Everything the spread reached, seeds included. The entity trigger tests membership here. */
  readonly activatedIds: ReadonlySet<string>;
  /**
   * The activation-weighted centroid the second pass built, when it built one. Absent on a
   * query that anchored nothing and on a substrate whose context vectors are still pending, and
   * the situation trigger simply does not fire then. The other two still can.
   */
  readonly centroid?: Vector;
  readonly now: Date;
  /** `AION_RECALL_INTENTION_SITUATION_FLOOR`: the cosine a situation match has to clear. */
  readonly situationFloor: number;
  /** `AION_RECALL_MAX_INTENTIONS`: how many matches the bucket may hold. */
  readonly limit: number;
  /**
   * Ids this run already produced. An intention the query found on its own answers in facts,
   * where the search put it, and serving it twice under two rationales explains it with
   * neither. Excluded before the cap, so a duplicate never spends a slot.
   */
  readonly exclude?: ReadonlySet<string>;
};

export type IntentionTriggerMatch = {
  readonly id: string;
  readonly kind: IntentionTriggerKind;
  /**
   * The cosine a situation match cleared. One for the other two kinds: a subject in the
   * activated set and a date that has passed are conditions that held rather than measurements,
   * and there is no cosine to report for either.
   */
  readonly score: number;
};

/** The first condition this intention meets, in kind order, or nothing when it meets none. */
function firstTrigger(
  intention: TriggerableIntention,
  context: IntentionTriggerContext,
): IntentionTriggerMatch | undefined {
  const { id, subjectEntityId, triggerAfter, triggerVector } = intention;
  if (subjectEntityId !== undefined && context.activatedIds.has(subjectEntityId)) {
    return { id, kind: 'entity', score: 1 };
  }
  if (triggerAfter !== undefined && triggerAfter.getTime() <= context.now.getTime()) {
    return { id, kind: 'temporal', score: 1 };
  }
  if (context.centroid === undefined || triggerVector === undefined) {
    return undefined;
  }
  const similarity = cosineSimilarity(triggerVector, context.centroid);
  if (similarity < context.situationFloor) {
    return undefined;
  }
  return { id, kind: 'situation', score: similarity };
}

function byKindThenScore(left: IntentionTriggerMatch, right: IntentionTriggerMatch): number {
  const byKind = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
  if (byKind !== 0) {
    return byKind;
  }
  return right.score - left.score;
}

/**
 * Which of the open intentions this moment brings back, best first and capped. Pure and total:
 * the same inputs give the same answer, and an intention carrying no condition the run meets is
 * simply absent rather than ranked last.
 */
export function matchIntentionTriggers(
  intentions: readonly TriggerableIntention[],
  context: IntentionTriggerContext,
): readonly IntentionTriggerMatch[] {
  if (context.limit <= 0) {
    return [];
  }
  const matches: IntentionTriggerMatch[] = [];
  const matched = new Set<string>();
  for (const intention of intentions) {
    if (matched.has(intention.id) || context.exclude?.has(intention.id) === true) {
      continue;
    }
    const match = firstTrigger(intention, context);
    if (match === undefined) {
      continue;
    }
    matched.add(intention.id);
    matches.push(match);
  }
  return matches.sort(byKindThenScore).slice(0, context.limit);
}

/**
 * A triggered intention as the pack holds it. It reaches its own bucket by how it arrived
 * rather than by its label, the way a resonant discovery does: the same Goal admitted by an
 * ordinary search answers in facts, and only the trigger provenance moves it.
 *
 * There is no `admittedBy`. The admission rules are the content floors and the context
 * threshold, and none of them judged this item: it was not measured against the query at all.
 * The method and the path are what explain it instead.
 */
export function triggeredIntentionItem(
  candidate: SeedCandidate,
  match: IntentionTriggerMatch,
): FusedItem {
  return {
    id: candidate.id,
    labels: candidate.labels,
    content: candidate.content,
    ...(candidate.occurredAt === undefined ? {} : { occurredAt: candidate.occurredAt }),
    ...(candidate.sourceEpisodeId === undefined
      ? {}
      : { sourceEpisodeId: candidate.sourceEpisodeId }),
    ...(candidate.why === undefined ? {} : { why: candidate.why }),
    currency: candidate.currency,
    ...(candidate.supersededBy === undefined ? {} : { supersededBy: candidate.supersededBy }),
    rationale: {
      method: INTENTION_TRIGGER_METHOD,
      score: match.score,
      path: INTENTION_TRIGGER_PATHS[match.kind],
    },
    relevance: match.score,
    score: match.score,
    measured: match.score,
  };
}
