import type { Rationale } from '@aion/protocol';
import type { Currency, SupersededBy } from '../../infrastructure/graph/read-modes.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { hashContent } from '../../reflection/domain/content.js';
import {
  absoluteRelevance,
  admitsOnEvidence,
  type AdmissionPolicy,
  type AdmissionReport,
  type Measurement,
} from './admission.js';
import { applyClusterCap, mmrOrder } from './ranking.js';

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
};

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
  /** Why the item surfaced, as the pack reports it. Its score is the method's own. */
  readonly rationale: Rationale;
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
   */
  readonly activation?: number;
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
   * The strongest cosine any method measured for this item, zero when none did. Comparable
   * between queries and between items, which is what makes it the number a pack may print.
   */
  readonly measured: number;
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
 * clears the absolute floors (`admitsOnEvidence`), and never otherwise. A node the spread
 * reached carries no measurement, so it is refused however strongly the rest of the pack
 * measured. Off-topic packs used to fill to budget precisely because one incidental hit
 * unlocked every node activation had touched.
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

      const held = merged.get(candidate.id);
      if (held === undefined) {
        merged.set(candidate.id, {
          best: candidate,
          score: contribution,
          relevance: candidate.relevance,
          evidence: [...measurementsOf(candidate)],
          ...(candidate.activation === undefined ? {} : { activation: candidate.activation }),
        });
        continue;
      }

      held.score += contribution;
      if (prefer(held, candidate)) {
        held.best = candidate;
      }
      held.relevance = Math.max(held.relevance, candidate.relevance);
      held.evidence.push(...measurementsOf(candidate));
      if (candidate.activation !== undefined) {
        held.activation = Math.max(held.activation ?? 0, candidate.activation);
      }
    }
  }

  const items: FusedItem[] = [];
  let droppedBelowFloor = 0;
  let droppedUnmeasured = 0;
  let anchored = false;
  for (const entry of merged.values()) {
    if (!admitsOnEvidence(entry.evidence, options.admission)) {
      // Two counters, because they are two different answers to "why is this pack thin".
      // Something measured the first and the measurement fell short; nothing measured the
      // second at all, and the spread alone is not a reason to serve a memory.
      if (entry.activation !== undefined && entry.relevance === 0) {
        droppedUnmeasured += 1;
        continue;
      }
      droppedBelowFloor += 1;
      continue;
    }
    anchored = true;
    const superseded = entry.best.currency === 'superseded';
    const ranked = entry.score * boostFor(entry.best.labels, options.labelBoosts);
    items.push({
      ...entry.best,
      relevance: entry.relevance,
      measured: absoluteRelevance(entry.evidence),
      // The merged evidence, not the winning candidate's own: the gate counted every
      // measurement, and a reader of the item downstream has to see the same set.
      evidence: [...entry.evidence],
      score: superseded ? ranked * SUPERSEDED_RANK_WEIGHT : ranked,
    });
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
      droppedDuplicateContent: items.length - deduped.length,
      droppedNearDuplicate: deduped.length - capped.length,
      anchored,
    },
  };
}
