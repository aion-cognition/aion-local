import type { CueWeight, RecallMethod } from '@aion/protocol';
import type { ScoredSeedCandidate, SeedCandidate } from '../../infrastructure/graph/seed-queries.js';

/**
 * The pure half of seed selection: what a seed is, how one node's contributions merge into
 * one seed, how many seeds a substrate of a given size is allowed to produce, and which of
 * them survive the budget. The Cypher lives in `graph/seed-queries.ts` and the orchestration
 * in `application/seeds.ts`; nothing here touches a driver, so the budget curve and the
 * reservation arithmetic are testable without a server.
 */

/** Also `RecallMethod` values, so fusion carries a provenance entry into an item rationale unchanged. */
export const SEED_STRATEGIES = [
  'vector',
  'bm25',
  'entity_resolution',
  'recency',
] as const satisfies readonly RecallMethod[];

export type SeedStrategy = (typeof SEED_STRATEGIES)[number];

/** The heaviest cue bucket. Every cue-driven score is expressed as a fraction of it. */
const MAX_CUE_WEIGHT = 3;

/**
 * Two numbers, because the cue bucket weights and the admission floor answer different
 * questions. `score` is the ranking number: the method's score scaled by the weight of the cue
 * that found it, which is how a query cue outranks a recent-turn cue. `relevance` is the
 * method's own measurement on its own comparable scale, which is what
 * `AION_VECTOR_ADMISSION_FLOOR` is measured against.
 *
 * Composing the two, measuring a weighted score against an absolute floor, deletes whole
 * buckets: at a floor of 0.5 no 1x recent-turn cue could ever contribute an item, however
 * perfect its match, because 1.0 scaled to a third of itself is 0.333.
 */
export type SeedProvenance = {
  readonly strategy: SeedStrategy;
  readonly score: number;
  readonly relevance: number;
  /**
   * A literal match on the cue as written: Lucene matched the whole cue as a phrase, or the
   * cue resolved an entity name exactly. A cosine is a measurement that has to clear a floor;
   * a literal match is evidence of its own, so admission reads the two differently.
   */
  readonly exact?: true;
  /** The cue text behind the hit; absent for recency, which no cue drives. */
  readonly cue?: string;
};

export type Seed = SeedCandidate & {
  /** The best of `provenance`, which is ordered to match. */
  readonly score: number;
  /** The strongest measurement any strategy made of this node, unscaled. */
  readonly relevance: number;
  readonly provenance: readonly SeedProvenance[];
};

export type SeedContribution = {
  readonly candidate: SeedCandidate;
  readonly strategy: SeedStrategy;
  readonly score: number;
  readonly relevance: number;
  readonly exact?: true;
  readonly cue?: string;
};

export function scaleByCueWeight(score: number, weight: CueWeight): number {
  return score * (weight / MAX_CUE_WEIGHT);
}

/**
 * A Lucene score has no fixed range, since it moves with the corpus and the query, so a raw
 * BM25 number is not comparable with a cosine similarity in the merge. Dividing by the best hit for
 * the same cue puts the leg on (0, 1] and leaves its internal ranking untouched. Vector and
 * entity scores are left alone; those are already cosine similarities.
 */
export function normalizeToBest(
  rows: readonly ScoredSeedCandidate[],
): readonly ScoredSeedCandidate[] {
  let best = 0;
  for (const row of rows) {
    if (row.score > best) {
      best = row.score;
    }
  }
  if (best <= 0) {
    return rows;
  }
  return rows.map((row) => ({ ...row, score: row.score / best }));
}

/**
 * Reciprocal rank, so the bias stays a bias: the most recently touched node competes with a
 * strong content hit and the tail falls away fast, rather than a flat recency list crowding
 * out everything the cues found.
 *
 * A rank, never a relevance. Recency weights the seed selection, and "this was touched
 * recently" is not a measurement of how well a node answers the query, so a recency
 * contribution carries `relevance: 0` (`RECENCY_RELEVANCE`). It seeds the spread, and that is
 * all: admission never counts it, as evidence or as corroboration.
 */
export function recencyScore(rank: number): number {
  return 1 / (1 + rank);
}

export const RECENCY_RELEVANCE = 0;

function compareProvenance(a: SeedProvenance, b: SeedProvenance): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  return a.strategy.localeCompare(b.strategy);
}

/** Best score wins; corroboration by more strategies breaks a tie, then id for a stable order. */
function compareSeeds(a: Seed, b: Seed): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.provenance.length !== b.provenance.length) {
    return b.provenance.length - a.provenance.length;
  }
  return a.id.localeCompare(b.id);
}

function toProvenance(contribution: SeedContribution): SeedProvenance {
  return {
    strategy: contribution.strategy,
    score: contribution.score,
    relevance: contribution.relevance,
    ...(contribution.exact === undefined ? {} : { exact: contribution.exact }),
    ...(contribution.cue === undefined ? {} : { cue: contribution.cue }),
  };
}

/**
 * Dedupe is by node id across every strategy, and a node found several ways keeps all of it:
 * the provenance list is what lets fusion explain the item and what makes corroboration
 * visible instead of collapsed into one number.
 */
export function mergeSeeds(
  contributions: readonly SeedContribution[],
  limit: number,
): readonly Seed[] {
  const merged = new Map<string, { candidate: SeedCandidate; provenance: SeedProvenance[] }>();

  for (const contribution of contributions) {
    const entry = merged.get(contribution.candidate.id);
    if (entry === undefined) {
      merged.set(contribution.candidate.id, {
        candidate: contribution.candidate,
        provenance: [toProvenance(contribution)],
      });
      continue;
    }
    entry.provenance.push(toProvenance(contribution));
  }

  const seeds: Seed[] = [];
  for (const { candidate, provenance } of merged.values()) {
    provenance.sort(compareProvenance);
    const best = provenance[0];
    let relevance = 0;
    for (const entry of provenance) {
      relevance = Math.max(relevance, entry.relevance);
    }
    // Absent optionals stay absent rather than becoming explicit `undefined` keys, so a pack
    // item built by spreading a seed carries only the fields the seed actually has.
    seeds.push({
      id: candidate.id,
      labels: candidate.labels,
      content: candidate.content,
      ...(candidate.occurredAt === undefined ? {} : { occurredAt: candidate.occurredAt }),
      ...(candidate.isStructural === undefined ? {} : { isStructural: candidate.isStructural }),
      ...(candidate.sourceEpisodeId === undefined
        ? {}
        : { sourceEpisodeId: candidate.sourceEpisodeId }),
      currency: candidate.currency,
      ...(candidate.supersededBy === undefined ? {} : { supersededBy: candidate.supersededBy }),
      score: best === undefined ? 0 : best.score,
      relevance,
      provenance,
    });
  }

  seeds.sort(compareSeeds);
  return seeds.slice(0, Math.max(0, limit));
}

export type SeedBudgetCurve = {
  /** The budget on an empty or near-empty graph, and the floor of the curve. */
  readonly base: number;
  /** How many seeds one natural-log step of substrate growth is worth. */
  readonly growth: number;
  /** The ceiling, whatever the substrate grows to. */
  readonly cap: number;
};

/**
 * `base + growth * ln(population)`, clamped to the cap. A fixed budget is the wrong shape for
 * this: the seed set is the whole candidate set, so on a substrate of a few thousand memories
 * a fixed ten seeds leaves a node that answers the query above the admission floor and never
 * measured, because it was never a candidate. Growth has to be sublinear all the same, since
 * seeds are what the spread starts from and every one of them costs adjacency reads.
 *
 * The shipped constants (base 10, growth 2, cap 32) put a cold graph on the budget it used to
 * have, a substrate of a few thousand memories between twenty and thirty, and the cap in reach
 * of about sixty thousand nodes rather than at a number no graph here will see. The cap also
 * stays under the co-activation limit, so the spread has room to return something the seeds did
 * not already carry.
 */
export function seedBudget(memoryCount: number, curve: SeedBudgetCurve): number {
  const population = Number.isFinite(memoryCount) && memoryCount > 1 ? memoryCount : 1;
  const scaled = Math.round(curve.base + curve.growth * Math.log(population));
  return Math.max(1, Math.min(curve.cap, scaled));
}

/**
 * The share of the budget each leg is guaranteed before the merged ranking spends the rest.
 * They sum to 0.8, so a fifth of the budget stays open to whatever scored best overall.
 *
 * Unreserved, the merged ranking is not a fair fight: an exact entity-name match scores 1.0 by
 * construction, a BM25 leg normalized to its own best hit puts its top row at 1.0 whatever it
 * matched, and the most recently touched node scores 1.0 as well, while a cosine that genuinely
 * answers the query arrives at 0.6 to 0.8. Ten slots ranked by that number are lexical, and the
 * vector leg is crowded out of its own candidate set.
 */
export const LEG_RESERVATION_SHARES: Readonly<Record<SeedStrategy, number>> = {
  vector: 0.35,
  bm25: 0.2,
  entity_resolution: 0.15,
  recency: 0.1,
};

/**
 * At least one slot per leg once the budget can seat every leg. Below that there is nothing to
 * divide, so the merged ranking takes the whole budget and the reservations stand down rather
 * than handing a one-seed recall to whichever leg is named first.
 */
export function legReservations(budget: number): Readonly<Record<SeedStrategy, number>> {
  const slots: Record<SeedStrategy, number> = {
    vector: 0,
    bm25: 0,
    entity_resolution: 0,
    recency: 0,
  };
  if (budget < SEED_STRATEGIES.length) {
    return slots;
  }
  for (const strategy of SEED_STRATEGIES) {
    slots[strategy] = Math.max(1, Math.floor(budget * LEG_RESERVATION_SHARES[strategy]));
  }
  return slots;
}

function cueOf(seed: Seed, strategy: SeedStrategy): string {
  for (const entry of seed.provenance) {
    if (entry.strategy === strategy) {
      return entry.cue ?? '';
    }
  }
  return '';
}

/**
 * One leg's own ranking, dealt round by round across the cues behind it. Within a cue the
 * order is untouched, so this changes who gets the leg's reserved slots and never who is
 * better: a query cue that matches half the substrate would otherwise take every slot the leg
 * has and the cue naming the actual subject would contribute nothing.
 *
 * Groups are ordered by first appearance, which is the leg's own rank order, so the cue
 * holding the leg's best hit still deals first.
 */
export function roundRobinByCue(
  seeds: readonly Seed[],
  strategy: SeedStrategy,
): readonly Seed[] {
  const groups = new Map<string, Seed[]>();
  for (const seed of seeds) {
    const cue = cueOf(seed, strategy);
    const held = groups.get(cue);
    if (held === undefined) {
      groups.set(cue, [seed]);
      continue;
    }
    held.push(seed);
  }

  const dealt: Seed[] = [];
  const ordered = [...groups.values()];
  let round = 0;
  while (dealt.length < seeds.length) {
    for (const group of ordered) {
      const seed = group[round];
      if (seed !== undefined) {
        dealt.push(seed);
      }
    }
    round += 1;
  }
  return dealt;
}

export type ReservedSelectionInput = {
  /** Every contribution merged and ranked, uncut. Decides the order of the result. */
  readonly ranked: readonly Seed[];
  /** Each leg's own ranked list, which is what its reservation is filled from. */
  readonly byStrategy: Readonly<Record<SeedStrategy, readonly Seed[]>>;
  readonly budget: number;
};

/**
 * Reservations decide membership, the merged ranking decides order. Each leg fills its own
 * slots first, a node another leg already took costs nothing and the leg moves on to its next
 * candidate, and whatever the reservations leave unspent goes to the best-scoring seeds
 * overall.
 */
export function selectWithReservations(input: ReservedSelectionInput): readonly Seed[] {
  const budget = Math.max(0, Math.trunc(input.budget));
  if (budget === 0) {
    return [];
  }

  const reservations = legReservations(budget);
  const chosen = new Set<string>();
  for (const strategy of SEED_STRATEGIES) {
    let taken = 0;
    for (const seed of roundRobinByCue(input.byStrategy[strategy], strategy)) {
      if (taken >= reservations[strategy] || chosen.size >= budget) {
        break;
      }
      if (chosen.has(seed.id)) {
        continue;
      }
      chosen.add(seed.id);
      taken += 1;
    }
  }

  for (const seed of input.ranked) {
    if (chosen.size >= budget) {
      break;
    }
    chosen.add(seed.id);
  }

  return input.ranked.filter((seed) => chosen.has(seed.id));
}
