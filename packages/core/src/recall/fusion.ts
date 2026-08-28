import type { Rationale } from '@aion/protocol';
import type { Currency, SupersededBy } from '../graph/read-modes.js';
import type { Vector } from '../providers/types.js';
import { hashContent } from '../reflection/content.js';

/**
 * Whitepaper §5.3 and §5.5. Each retrieval leg hands over its own ranked list; this module
 * turns them into one ordered candidate set — weighted RRF by default, MMR behind the
 * reranker flag — and applies the two policies that decide what may surface at all: the
 * minimum relevance floor (PRD §3.1, "empty beats noisy") and PRD §5.5's currency ranking.
 */

/** Whitepaper §5.3's three legs. The weights they fuse under are `config.search.weights`. */
export type FusionLeg = 'vector' | 'bm25' | 'graph_traversal';

export type FusionCandidate = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly content: string;
  readonly occurredAt?: Date;
  readonly currency: Currency;
  readonly supersededBy?: SupersededBy;
  /** Whitepaper §5.7's impression of why the item surfaced. Its score is the method's own. */
  readonly rationale: Rationale;
  /**
   * The method score on a comparable [0,1] scale, which is what the floor is measured
   * against. The fused score is a rank statistic — an RRF sum sits near 1/k whatever the
   * retrieval quality behind it — so a floor applied to it would either drop everything or
   * nothing.
   */
  readonly relevance: number;
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
};

export type FusionOptions = {
  readonly rrfConstant: number;
  readonly minRelevance: number;
  readonly reranker: 'rrf' | 'mmr';
  readonly mmrLambda: number;
  /**
   * Content vectors by node id, fetched only when the reranker is MMR. An id with no
   * vector is treated as maximally distinct, so a partial map degrades toward relevance
   * order rather than toward an arbitrary one.
   */
  readonly vectors?: ReadonlyMap<string, Vector>;
};

/**
 * PRD §5.5: superseded knowledge is ranked, not hidden. The same factor spreading
 * activation applies in traversal is applied again here, so lineage is consistently a
 * half-weight answer wherever it competes with the current fact. A constant rather than a
 * knob: this is the bitemporal contract's ranking treatment, not an install-time taste.
 */
export const SUPERSEDED_RANK_WEIGHT = 0.5;

/** Whitepaper §5.5: `1 / (k + rank)`, ranks counted from 1. */
export function reciprocalRank(rank: number, k: number): number {
  return 1 / (k + rank + 1);
}

export function cosineSimilarity(left: Vector, right: Vector): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

type Accumulator = {
  best: FusionCandidate;
  score: number;
  relevance: number;
};

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
 * Whitepaper §5.7 dedupes by content hash before packaging: two node ids carrying the same
 * text are one memory to the reader. The higher-ranked one survives with its own rationale;
 * nothing merges, because a rationale that named two paths would explain neither.
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

function redundancy(
  candidate: FusedItem,
  selected: readonly FusedItem[],
  vectors: ReadonlyMap<string, Vector> | undefined,
): number {
  const candidateVector = vectors?.get(candidate.id);
  if (candidateVector === undefined) {
    return 0;
  }
  let worst = 0;
  for (const chosen of selected) {
    const chosenVector = vectors?.get(chosen.id);
    if (chosenVector === undefined) {
      continue;
    }
    worst = Math.max(worst, cosineSimilarity(candidateVector, chosenVector));
  }
  return worst;
}

/**
 * Whitepaper §5.5's diversity-aware alternative: `lambda * relevance - (1 - lambda) *
 * redundancy`, selected greedily. Redundancy is cosine distance between content vectors
 * rather than the whitepaper's Jaccard word overlap, because word overlap needs a
 * tokenizer and this build keeps text machinery out of the cognitive path entirely
 * (PRD §2) — the embedding is the redundancy signal the substrate already holds.
 *
 * Relevance is normalized against the top fused score first. Raw RRF sums cluster near
 * `1/k` while cosine similarity spans [0,1], so mixing them unnormalized would make lambda
 * meaningless and hand every ordering to the diversity term.
 */
export function mmrOrder(
  items: readonly FusedItem[],
  lambda: number,
  vectors: ReadonlyMap<string, Vector> | undefined,
): FusedItem[] {
  const top = items[0]?.score ?? 0;
  if (items.length <= 1 || top <= 0) {
    return [...items];
  }

  const remaining = [...items];
  const selected: FusedItem[] = [];
  const first = remaining.shift();
  if (first !== undefined) {
    selected.push(first);
  }

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (candidate === undefined) {
        continue;
      }
      const score =
        lambda * (candidate.score / top) -
        (1 - lambda) * redundancy(candidate, selected, vectors);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen !== undefined) {
      selected.push(chosen);
    }
  }

  return selected;
}

/**
 * Whitepaper §5.5. Ranks fuse reciprocally so the legs need no score calibration between
 * them, and each leg's contribution is scaled by its §5.3 weight (0.4 vector, 0.3 keyword,
 * 0.3 graph), which is where the two sections meet: RRF decides the shape, the weights
 * decide how much each leg is trusted.
 *
 * A candidate with no content is counted for rank and then dropped — it was a real hit, so
 * removing its rank would promote everything under it, but a memory the pack cannot render
 * (a Session node, say) has nothing to hand the agent.
 */
export function fuse(
  lists: readonly RankedList[],
  options: FusionOptions,
): readonly FusedItem[] {
  const merged = new Map<string, Accumulator>();

  for (const list of lists) {
    let rank = 0;
    for (const candidate of list.candidates) {
      const contribution = list.weight * reciprocalRank(rank, options.rrfConstant);
      rank += 1;
      if (candidate.content.trim().length === 0) {
        continue;
      }

      const held = merged.get(candidate.id);
      if (held === undefined) {
        merged.set(candidate.id, {
          best: candidate,
          score: contribution,
          relevance: candidate.relevance,
        });
        continue;
      }

      held.score += contribution;
      if (prefer(held, candidate)) {
        held.best = candidate;
      }
      held.relevance = Math.max(held.relevance, candidate.relevance);
    }
  }

  const items: FusedItem[] = [];
  for (const entry of merged.values()) {
    if (entry.relevance < options.minRelevance) {
      continue;
    }
    const superseded = entry.best.currency === 'superseded';
    items.push({
      ...entry.best,
      relevance: entry.relevance,
      score: superseded ? entry.score * SUPERSEDED_RANK_WEIGHT : entry.score,
    });
  }

  items.sort(compareFused);
  const deduped = dedupeByContent(items);
  if (options.reranker === 'mmr') {
    return mmrOrder(deduped, options.mmrLambda, options.vectors);
  }
  return deduped;
}
