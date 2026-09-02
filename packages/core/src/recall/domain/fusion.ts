import type { Rationale } from '@aion/protocol';

import {
  admissionEvidence,
  wasMeasured,
  type AdmissionEvidence,
  type AdmissionPolicy,
  type AdmissionReport,
  type Measurement,
  type TypedInboundEvidence,
} from './admission.js';
import { applyClusterCap, mmrOrder } from './ranking.js';
import type { Currency, SupersededBy } from '../../infrastructure/graph/read-modes.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { hashContent } from '../../reflection/domain/content.js';

/**
 * Each retrieval leg hands over its own ranked list; this module turns them into one ordered
 * candidate set (weighted RRF by default, MMR behind the reranker flag) and applies the two
 * policies that decide what may surface at all: `admission.ts`'s absolute floors, where empty
 * beats noisy, and currency ranking. Ordering, near-duplicate capping and MMR live in
 * `ranking.ts`.
 */

/** The three retrieval legs. The weights they fuse under are `config.search.weights`. */
export type FusionLeg = 'vector' | 'bm25' | 'graph_traversal';

export type FusionResult = {
  readonly items: readonly FusedItem[];
  readonly admission: AdmissionReport;
  /** Per-method sole/shared find counts and summed RRF contribution, admitted items only. */
  readonly methodStats: MethodLegStats;
};

/**
 * One method's showing in one pack: how many admitted items it found with no other method
 * also finding them, how many it shared credit for, and how much RRF weight it carried into
 * admitted items either way. `prefer` below still picks one method to explain an item's
 * rationale, but every method that helped find it counts here, which is what lets a method
 * that never wins the rationale still show up as contributing.
 */
export type MethodLegStat = {
  readonly sole: number;
  readonly shared: number;
  readonly rrfContribution: number;
};

/** Keyed by `rationale.method`; a method that found nothing this pack carries no key at all. */
export type MethodLegStats = Readonly<Partial<Record<Rationale['method'], MethodLegStat>>>;

export type FusionCandidate = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly content: string;
  readonly occurredAt?: Date;
  readonly currency: Currency;
  readonly supersededBy?: SupersededBy;
  /** The Member and the global Workspace: real traversal hits, but not memories to hand back. */
  readonly isStructural?: boolean;
  /** A Turn's parent episode, so the episodes bucket can hold one item per episode. */
  readonly sourceEpisodeId?: string;
  /**
   * Distinct current episodes mentioning the entity, `entity-dedup-queries.ts`'s own
   * canonical-selection signal carried into ranking. Absent for a node type `MENTIONS`
   * never targets, which `mentionSalience` reads the same as a one-off sighting.
   */
  readonly mentionCount?: number;
  /** Why the item surfaced, as the pack reports it. Its score is the method's own. */
  readonly rationale: Rationale;
  /** The node's own stated reason (a Decision's `rationale` property), distinct from `rationale` above. */
  readonly why?: string;
  /**
   * The producing method's own number, on the producing method's own scale. Used for ranking
   * and for choosing which leg owns the rationale; never for admission, and never reported as
   * a confidence: a normalized BM25 score puts the top lexical hit of any query at 1.00.
   * `evidence` is what admission and `confidence` read.
   *
   * Zero when the method that produced the candidate measures nothing: a recency hit says
   * "touched lately", not "matches the query".
   */
  readonly relevance: number;
  /**
   * Every measurement behind the candidate, one entry per method and cue. A candidate that
   * carries none is read as carrying exactly one, its own `rationale.method` at `relevance`.
   */
  readonly evidence?: readonly Measurement[];
  /**
   * Set only for a node no retrieval leg found, reached by spreading activation alone. Its
   * own floor is the spread's `min_activation`, already applied by the time it gets here.
   * Admission never reads it as evidence: what admits such a node is the cosine arrival
   * scoring measured for it, carried in `evidence` like any other measurement. What the gate
   * does read it for is the tally: an unmeasured arrival and an unmeasured recency seed are
   * different failures, and this is the only field that tells them apart.
   */
  readonly activation?: number;
  /**
   * The strongest typed edge (CONTRADICTS, SUPERSEDES, CAUSES) that reached this arrival during
   * spreading activation, when one did. What the typed-admission tier in `admissionEvidence`
   * reads for an item no seed strategy found and no cosine alone would clear.
   */
  readonly typedEvidence?: TypedInboundEvidence;
};

export type RankedList = {
  readonly leg: FusionLeg;
  readonly weight: number;
  /** Best first: position is the rank RRF reads, so a list arrives already ordered. */
  readonly candidates: readonly FusionCandidate[];
};

export type FusedItem = FusionCandidate & {
  /** Weighted RRF across every leg that produced the item, down-weighted when superseded. */
  readonly score: number;
  /**
   * The strongest cosine the admitting rule counted, zero when it counted none. Comparable
   * between queries and between items, which is what makes it the number a pack may print.
   */
  readonly measured: number;
  /**
   * The rule that admitted the item and the measurements that qualified under it. Optional
   * only for a caller that assembles an item by hand; every path that runs the gate sets it,
   * and a pack renders the rule beside the number so the two cannot drift apart.
   */
  readonly admittedBy?: AdmissionEvidence;
};

export type FusionOptions = {
  readonly rrfConstant: number;
  readonly admission: AdmissionPolicy;
  readonly reranker: 'rrf' | 'mmr';
  readonly mmrLambda: number;
  /** How many members of one near-duplicate cluster a bucket may hold (`AION_PACK_CLUSTER_CAP`). */
  readonly clusterCap: number;
  /**
   * Per-label multipliers on the fused score, empty on a query with no judged intent. Ranking
   * only: a boost cannot admit an item the floors rejected, since admission has already run
   * on evidence by the time this applies. `facts.ts`'s `labelBoosts` builds the map.
   */
  readonly labelBoosts?: Readonly<Record<string, number>>;
  /**
   * Content vectors by node id, fetched only when the reranker is MMR. An id with no
   * vector is treated as maximally distinct, so a partial map degrades toward relevance
   * order rather than toward an arbitrary one. The cluster cap's cosine leg reuses this
   * same map rather than fetching its own (see `ranking.ts`).
   */
  readonly vectors?: ReadonlyMap<string, Vector>;
};

/**
 * Superseded knowledge is ranked, not hidden. The same factor spreading activation applies
 * in traversal is applied again here, so lineage is consistently a half-weight answer
 * wherever it competes with the current fact. A constant rather than a knob: this is the
 * bitemporal contract's ranking treatment, not an install-time taste.
 */
export const SUPERSEDED_RANK_WEIGHT = 0.5;

/** `1 / (k + rank)`, ranks counted from 1. */
export function reciprocalRank(rank: number, k: number): number {
  return 1 / (k + rank + 1);
}

type Accumulator = {
  best: FusionCandidate;
  score: number;
  relevance: number;
  evidence: Measurement[];
  activation?: number;
  typedEvidence?: TypedInboundEvidence;
  /** RRF contribution summed per producing method, the leg-share stats `fuse` reports. */
  methodContribution: Map<Rationale['method'], number>;
};

/** A candidate that names no evidence carries exactly one measurement: the one that found it. */
function measurementsOf(candidate: FusionCandidate): readonly Measurement[] {
  if (candidate.evidence !== undefined) {
    return candidate.evidence;
  }
  return [{ method: candidate.rationale.method, relevance: candidate.relevance }];
}

/**
 * The strongest retrieval leg owns the rationale. An item that several legs found keeps
 * the one with the highest method score, so a seed that vector search ranked first is
 * explained as a vector hit rather than by the activation pass that re-encountered it.
 */
function prefer(held: Accumulator, candidate: FusionCandidate): boolean {
  if (candidate.relevance !== held.relevance) {
    return candidate.relevance > held.relevance;
  }
  return candidate.rationale.method.localeCompare(held.best.rationale.method) < 0;
}

/** The strongest boost any of the item's labels carries; 1 when none of them carries one. */
function boostFor(
  labels: readonly string[],
  boosts: Readonly<Record<string, number>> | undefined,
): number {
  if (boosts === undefined) {
    return 1;
  }
  let factor = 1;
  for (const label of labels) {
    factor = Math.max(factor, boosts[label] ?? 1);
  }
  return factor;
}

/**
 * Mention-count ranking prior's weight: how much each distinct episode past the first lifts
 * an entity's score, log-scaled so the fortieth adds far less than the second. Fixed here
 * rather than as a knob (the intended home is `AION_MENTION_SALIENCE_WEIGHT`) until this prior
 * earns one.
 */
const MENTION_SALIENCE_WEIGHT = 0.1;

/**
 * 1 for a one-off sighting or a node type `MENTIONS` never targets, since a single mention is
 * the baseline nothing should rank below. Combines with `boostFor` by multiplication, the same
 * way the two priors would combine if `labelBoosts` ever named an Entity label.
 */
function mentionSalience(mentionCount: number | undefined): number {
  if (mentionCount === undefined || mentionCount <= 1) {
    return 1;
  }
  return 1 + MENTION_SALIENCE_WEIGHT * Math.log1p(mentionCount - 1);
}

/** Current before superseded on an exact tie; id last, so one graph produces one order. */
function compareFused(left: FusedItem, right: FusedItem): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.currency !== right.currency) {
    return left.currency === 'current' ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Dedupe by content hash before packaging: two node ids carrying the same text are one
 * memory to the reader. The higher-ranked one survives with its own rationale; nothing
 * merges, because a rationale that named two paths would explain neither.
 */
function dedupeByContent(items: readonly FusedItem[]): FusedItem[] {
  const seen = new Set<string>();
  const kept: FusedItem[] = [];
  for (const item of items) {
    const hash = hashContent(item.content);
    if (seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    kept.push(item);
  }
  return kept;
}

/**
 * Ranks fuse reciprocally so the legs need no score calibration between them, and each leg's
 * contribution is scaled by its weight (0.4 vector, 0.3 keyword, 0.3 graph). RRF decides the
 * shape, the weights decide how much each leg is trusted.
 *
 * A candidate with no content is counted for rank and then dropped. It was a real hit, so
 * removing its rank would promote everything under it, but a memory the pack cannot render
 * (a Session node, say) has nothing to hand the agent. A structural node, the Member or the
 * global Workspace, is dropped the same way and for the same reason: it is the graph's
 * connectivity, not something the user ever told the substrate.
 *
 * One admission rule, and it is per item: a candidate reaches the pack when its own evidence
 * clears the absolute floors (`admissionEvidence`), and never otherwise. A node the spread
 * reached faces that rule on its own measured cosine, so it is admitted on what it answers
 * rather than on what the rest of the pack measured. Off-topic packs used to fill to budget
 * precisely because one incidental hit unlocked every node activation had touched.
 *
 * The report is what makes a thin pack readable: an empty result with `considered` at zero is
 * a substrate with nothing in it, and the same result with `considered` at forty is a floor
 * doing its job.
 */
export function fuse(lists: readonly RankedList[], options: FusionOptions): FusionResult {
  const merged = new Map<string, Accumulator>();

  for (const list of lists) {
    let rank = 0;
    for (const candidate of list.candidates) {
      const contribution = list.weight * reciprocalRank(rank, options.rrfConstant);
      rank += 1;
      if (candidate.content.trim().length === 0 || candidate.isStructural === true) {
        continue;
      }

      const { method } = candidate.rationale;
      const held = merged.get(candidate.id);
      if (held === undefined) {
        merged.set(candidate.id, {
          best: candidate,
          score: contribution,
          relevance: candidate.relevance,
          evidence: [...measurementsOf(candidate)],
          methodContribution: new Map([[method, contribution]]),
          ...(candidate.activation === undefined ? {} : { activation: candidate.activation }),
          ...(candidate.typedEvidence === undefined
            ? {}
            : { typedEvidence: candidate.typedEvidence }),
        });
        continue;
      }

      held.score += contribution;
      if (prefer(held, candidate)) {
        held.best = candidate;
      }
      held.relevance = Math.max(held.relevance, candidate.relevance);
      held.evidence.push(...measurementsOf(candidate));
      held.methodContribution.set(
        method,
        (held.methodContribution.get(method) ?? 0) + contribution,
      );
      if (candidate.activation !== undefined) {
        held.activation = Math.max(held.activation ?? 0, candidate.activation);
      }
      if (
        candidate.typedEvidence !== undefined &&
        (held.typedEvidence === undefined ||
          candidate.typedEvidence.contribution > held.typedEvidence.contribution)
      ) {
        held.typedEvidence = candidate.typedEvidence;
      }
    }
  }

  const items: FusedItem[] = [];
  const methodStats = new Map<Rationale['method'], MethodLegStat>();
  let droppedBelowFloor = 0;
  let droppedUnmeasured = 0;
  let droppedUnmeasuredArrival = 0;
  let anchored = false;
  let typedAdmitted = 0;
  for (const entry of merged.values()) {
    const evidence = admissionEvidence(entry.evidence, options.admission, entry.typedEvidence);
    if (evidence === undefined) {
      // Three counters, because they are three different answers to "why is this pack thin".
      // Something measured the first and the measurement fell short. Nothing measured the
      // second at all, which is ordinary for a seed the recency or plain-BM25 leg found, since
      // neither measures anything against the query. The third is the one worth alarming on:
      // a node the spread reached on its own, whose content vector is still pending, so the
      // traversal leg is contributing reach that no floor can ever judge.
      if (wasMeasured(entry.evidence)) {
        droppedBelowFloor += 1;
        continue;
      }
      droppedUnmeasured += 1;
      if (entry.activation !== undefined) {
        droppedUnmeasuredArrival += 1;
      }
      continue;
    }
    anchored = true;
    if (evidence.rule === 'typed_admission') {
      typedAdmitted += 1;
    }
    const superseded = entry.best.currency === 'superseded';
    const ranked =
      entry.score *
      boostFor(entry.best.labels, options.labelBoosts) *
      mentionSalience(entry.best.mentionCount);
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
      score: superseded ? ranked * SUPERSEDED_RANK_WEIGHT : ranked,
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

  items.sort(compareFused);
  const deduped = dedupeByContent(items);
  const capped = applyClusterCap(deduped, options.clusterCap, options.vectors);
  const ordered =
    options.reranker === 'mmr' ? mmrOrder(capped, options.mmrLambda, options.vectors) : capped;

  return {
    items: ordered,
    admission: {
      policy: options.admission,
      considered: merged.size,
      admitted: ordered.length,
      droppedBelowFloor,
      droppedUnmeasured,
      droppedUnmeasuredArrival,
      droppedDuplicateContent: items.length - deduped.length,
      droppedNearDuplicate: deduped.length - capped.length,
      anchored,
      typedAdmitted,
    },
    methodStats: Object.fromEntries(methodStats),
  };
}

/**
 * Folds in a method whose admitted items never pass through `fuse`'s own merge, namely
 * resonance: it runs after fusion, over what activation reached but this pass never admitted,
 * so its finds would otherwise carry no leg-share stats at all. Always sole, since resonance
 * excludes every id fusion or a seed strategy already reached, and it never competes in RRF.
 */
export function withSoleMethod(
  stats: MethodLegStats,
  method: Rationale['method'],
  count: number,
): MethodLegStats {
  if (count === 0) {
    return stats;
  }
  const existing = stats[method] ?? { sole: 0, shared: 0, rrfContribution: 0 };
  return { ...stats, [method]: { ...existing, sole: existing.sole + count } };
}
