import type { Rationale } from '@aion/protocol';

import type { AdmissionDecision, AdmissionEvidence } from './admission.js';
import {
  SUPERSEDED_RANK_WEIGHT,
  boostFor,
  mentionSalience,
  type Accumulator,
  type FusedItem,
  type FusionOptions,
  type MethodLegStat,
} from './fusion.js';

/**
 * The two halves of admitting one candidate into the pack: `admitEntry`, shared by every rule
 * that lets an item through, and `admitByPathStrength`, the disclosed lane that runs after
 * `fuse`'s ordinary gate has finished with everyone. Split out of `fusion.ts` at the 500-line
 * cap; the two files import each other's exports, which ES modules resolve fine since neither
 * uses the other's binding at module-evaluation time.
 */

/**
 * Folds one admitted entry into the pack: the ranked score (RRF, boosted, superseded-discounted
 * the same way for every admission rule), the decision record, the fused item, and the leg-share
 * stats. Shared between `fuse`'s ordinary gate and the path-strength lane below, which admits by
 * a different rule but reports itself identically once it has decided to let an entry through.
 */
export function admitEntry(
  entry: Accumulator,
  evidence: AdmissionEvidence,
  options: FusionOptions,
  items: FusedItem[],
  decisions: AdmissionDecision[],
  methodStats: Map<Rationale['method'], MethodLegStat>,
): void {
  const superseded = entry.best.currency === 'superseded';
  const ranked =
    entry.score *
    boostFor(entry.best.labels, options.labelBoosts) *
    mentionSalience(entry.best.mentionCount);
  const fusedScore = superseded ? ranked * SUPERSEDED_RANK_WEIGHT : ranked;
  decisions.push({
    id: entry.best.id,
    reason: 'admitted',
    measurements: [...entry.evidence],
    relevance: entry.relevance,
    ...(entry.activation === undefined ? {} : { activation: entry.activation }),
    rule: evidence.rule,
    score: evidence.score,
    fusedScore,
  });
  items.push({
    ...entry.best,
    relevance: entry.relevance,
    // What the rule read, not the best number anything measured. An item admitted on a
    // verbatim lexical hit used to print whatever weak cosine another leg returned for it,
    // which is how a pack showed 0.53 beside a 0.55 floor and read as a gate with a hole.
    measured: evidence.score,
    admittedBy: evidence,
    // The merged evidence, not the winning candidate's own: the gate counted every
    // measurement, and a reader of the item downstream has to see the same set.
    evidence: [...entry.evidence],
    // The merged typed evidence, for the same reason: the ledger writer downstream reads this
    // off the item rather than re-deriving it from the rationale string.
    ...(entry.typedEvidence === undefined ? {} : { typedEvidence: entry.typedEvidence }),
    score: fusedScore,
  });

  // A find two or more methods both made is shared for every one of them, not credited to
  // whichever `prefer` picked to explain the item: that credited a shared find to its
  // strongest leg alone and left every other contributing method reading as a sole find of
  // zero, which is what made activation's real share invisible in `aion stats`.
  const shared = entry.methodContribution.size > 1;
  for (const [method, contribution] of entry.methodContribution) {
    const stat = methodStats.get(method) ?? { sole: 0, shared: 0, rrfContribution: 0 };
    methodStats.set(method, {
      sole: stat.sole + (shared ? 0 : 1),
      shared: stat.shared + (shared ? 1 : 0),
      rrfContribution: stat.rrfContribution + contribution,
    });
  }
}

/**
 * Best activation first, so the lane spends its bounded slots on the arrivals the spread found
 * the strongest evidence for; id last, so a tie resolves the same way twice over one graph.
 */
function byActivationDescending(left: Accumulator, right: Accumulator): number {
  const byActivation = (right.activation ?? 0) - (left.activation ?? 0);
  if (byActivation !== 0) {
    return byActivation;
  }
  return left.best.id.localeCompare(right.best.id);
}

/**
 * The disclosed path-strength lane. Every candidate here already failed the ordinary gate on
 * `unmeasured_arrival`: reached by spreading activation alone, with no cosine and no exact match
 * ever measured against the query, which is precisely what a floor can never judge. The lane
 * admits the strongest few by activation, the one signal the spread already computes that sums
 * multi-path accumulation and decays with hop count and edge type (`activation.ts`), bounded to
 * `options.pathStrengthSlots` per pack rather than to any new threshold: the floor policy itself
 * is unchanged, and boundedness by slot count is what keeps this a disclosed extra reach rather
 * than a second floor. Zero candidates or a zero-slot config is a no-op, so a caller that has not
 * asked for the lane sees no cost and no change.
 */
export function admitByPathStrength(
  candidates: readonly Accumulator[],
  options: FusionOptions,
  items: FusedItem[],
  decisions: AdmissionDecision[],
  methodStats: Map<Rationale['method'], MethodLegStat>,
): number {
  if (options.pathStrengthSlots <= 0 || candidates.length === 0) {
    return 0;
  }
  const chosen = [...candidates].sort(byActivationDescending).slice(0, options.pathStrengthSlots);
  for (const entry of chosen) {
    // Clamped rather than trusted: activation is a decayed, hub-inhibited sum of contributions
    // and stays under 1 in every measured run, but nothing in the algorithm proves it always
    // will, and the wire's `confidence` is bounded at 1.
    const score = Math.min(1, Math.max(0, entry.activation ?? 0));
    admitEntry(
      entry,
      { rule: 'path_strength', score, qualifying: [`activation ${score.toFixed(2)}`] },
      options,
      items,
      decisions,
      methodStats,
    );
  }
  return chosen.length;
}
