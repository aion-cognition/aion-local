import type { Cue } from '@aion/protocol';

import type { Measurement } from './admission.js';

/**
 * What may sit in the facts bucket, and in what order. The admission gate decides whether a
 * candidate is a memory at all; this decides whether it is an *answer*.
 *
 * On an entirely decision-oriented workload over 168 fact slots: Entity glosses took 58% and
 * Decision nodes took 3%, and the item that ranked first for "what did we decide about the
 * remittance ingest transport" was a Goal restating the question. Three rules address this gap,
 * each grounded in evidence:
 *
 *  - a Goal or Plan whose text is the query said back is not an answer (`queryRestatements`);
 *  - a decision-shaped query wants Decision and Insight over everything else (`labelBoosts`);
 *  - one pack may hold only so many entity glosses (`pack.ts`'s gloss cap).
 *
 * Nothing here reads words. A restatement is judged by the cosine between the node's content
 * vector and the query's own cue, a measurement the vector leg already made, and the intent
 * behind the boost is the cue model's judgment, carried on the cue itself.
 */

/**
 * The two cognitive types that state an intention rather than a finding, and so the two whose
 * text can restate a question without answering it. A Decision, Insight, Concept or Event that
 * scores high against the query scores high because it *is* the answer.
 */
export const RESTATEMENT_LABELS: readonly string[] = ['Goal', 'Plan'];

/** The types that answer "what did we decide" and "why did we reject". */
export const DECISION_INTENT_LABELS: readonly string[] = ['Decision', 'Insight'];

/**
 * The label whose content is a gloss: a name and a one-line description, 60 to 130 characters,
 * lexically dense and cheap against the token budget, which is how the measured entity glosses won
 * both the lexical score and the budget-fit check at once.
 */
export const GLOSS_LABEL = 'Entity';

/** Only a cosine can be compared against the restatement floor; a Lucene score cannot. */
const COSINE_METHOD = 'vector';

export type RestatementPolicy = {
  /**
   * Cosine at or above which a Goal or Plan is the query said back rather than answered.
   * Measured, not pinned: see `defaults.ts` and `facts-calibration.int.test.ts`.
   */
  readonly floor: number;
  /** The cue texts that came from the query, which is what a restatement restates. */
  readonly queryCues: ReadonlySet<string>;
};

export type RestatementCandidate = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly evidence?: readonly Measurement[];
};

function restates(candidate: RestatementCandidate, policy: RestatementPolicy): boolean {
  if (!candidate.labels.some((label) => RESTATEMENT_LABELS.includes(label))) {
    return false;
  }
  for (const measurement of candidate.evidence ?? []) {
    if (measurement.method !== COSINE_METHOD || measurement.cue === undefined) {
      continue;
    }
    if (policy.queryCues.has(measurement.cue) && measurement.relevance >= policy.floor) {
      return true;
    }
  }
  return false;
}

/**
 * The Goal and Plan nodes that say the query back. Judged only where the vector leg already
 * measured the node against a query cue: a node no cosine reached is a node nothing claims is
 * a restatement, and inventing a measurement for it would mean embedding on the pack path.
 */
export function queryRestatements(
  candidates: readonly RestatementCandidate[],
  policy: RestatementPolicy,
): ReadonlySet<string> {
  const restating = new Set<string>();
  for (const candidate of candidates) {
    if (restates(candidate, policy)) {
      restating.add(candidate.id);
    }
  }
  return restating;
}

/** The cue texts a restatement is measured against: everything the caller's own query produced. */
export function queryCueTexts(cues: readonly Cue[]): ReadonlySet<string> {
  const texts = new Set<string>();
  for (const cue of cues) {
    if (cue.source === 'query' || cue.source === 'raw_query') {
      texts.add(cue.text);
    }
  }
  return texts;
}

export function hasDecisionIntent(cues: readonly Cue[]): boolean {
  return cues.some((cue) => cue.intent === 'decision');
}

/**
 * The thumb on the scale for a decision-shaped query, empty for every other query. RRF sums
 * are rank statistics clustered near `1/k`, so a multiplier translates directly into ranks:
 * at the shipped `rrfConstant` of 60 a factor of 1.25 lifts an item about fifteen places,
 * which is the facts cap. That is the size of the effect the boost is for (a Decision any leg
 * ranked reaches the bucket) and it is deliberately not larger, since an item no leg ranked
 * should not displace the top hit however well its label fits the question.
 */
export function labelBoosts(cues: readonly Cue[], boost: number): Readonly<Record<string, number>> {
  if (!hasDecisionIntent(cues)) {
    return {};
  }
  const boosts: Record<string, number> = {};
  for (const label of DECISION_INTENT_LABELS) {
    boosts[label] = boost;
  }
  return boosts;
}
