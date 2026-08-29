import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { SeedCandidate } from '../../infrastructure/graph/seed-queries.js';
import {
  LEG_RESERVATION_SHARES,
  SEED_STRATEGIES,
  legReservations,
  mergeSeeds,
  roundRobinByCue,
  seedBudget,
  selectWithReservations,
  type Seed,
  type SeedBudgetCurve,
  type SeedContribution,
  type SeedStrategy,
} from './seed-selection.js';

const CURVE: SeedBudgetCurve = {
  base: DEFAULTS.contextResonance.seedBudgetBase,
  growth: DEFAULTS.contextResonance.seedBudgetGrowth,
  cap: DEFAULTS.contextResonance.seedLimit,
};

/** The size the seed budget was measured against: a memory a few weeks of daily use produces. */
const POPULATED_SUBSTRATE = 6600;

function seed(id: string, strategy: SeedStrategy, score: number, cue?: string): Seed {
  return {
    id,
    labels: ['Episode', 'Memory', 'AionNode'],
    content: `content ${id}`,
    currency: 'current',
    score,
    relevance: strategy === 'recency' ? 0 : score,
    provenance: [
      {
        strategy,
        score,
        relevance: strategy === 'recency' ? 0 : score,
        ...(cue === undefined ? {} : { cue }),
      },
    ],
  };
}

function byStrategy(
  overrides: Partial<Record<SeedStrategy, readonly Seed[]>>,
): Readonly<Record<SeedStrategy, readonly Seed[]>> {
  return { vector: [], context_vector: [], bm25: [], entity_resolution: [], recency: [], ...overrides };
}

function ranked(...lists: ReadonlyArray<readonly Seed[]>): readonly Seed[] {
  return lists.flat().sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

describe('seedBudget', () => {
  it('gives an empty graph the base budget', () => {
    expect(seedBudget(0, CURVE)).toBe(CURVE.base);
    expect(seedBudget(1, CURVE)).toBe(CURVE.base);
  });

  it('grows with the log of the substrate, so ten times the memories is a fixed few more seeds', () => {
    const hundred = seedBudget(100, CURVE);
    const thousand = seedBudget(1000, CURVE);
    const tenThousand = seedBudget(10_000, CURVE);

    // Equal to a rounding step: each tenfold growth buys the same handful of seeds.
    expect(Math.abs(thousand - hundred - (tenThousand - thousand))).toBeLessThanOrEqual(1);
    expect(thousand - hundred).toBeLessThanOrEqual(5);
    expect(thousand).toBeGreaterThan(hundred);
  });

  it('is never smaller than the fixed budget it replaces', () => {
    for (const population of [0, 10, 100, 1000, POPULATED_SUBSTRATE, 1_000_000]) {
      expect(seedBudget(population, CURVE)).toBeGreaterThanOrEqual(10);
    }
  });

  it('more than doubles the candidate set on a populated substrate', () => {
    expect(seedBudget(POPULATED_SUBSTRATE, CURVE)).toBeGreaterThan(20);
  });

  it('stops at the cap however large the substrate grows', () => {
    expect(seedBudget(10 ** 9, CURVE)).toBe(CURVE.cap);
    expect(seedBudget(Number.MAX_SAFE_INTEGER, CURVE)).toBe(CURVE.cap);
  });

  it('leaves the spread room to return something the seeds did not already carry', () => {
    expect(seedBudget(10 ** 9, CURVE)).toBeLessThan(DEFAULTS.contextResonance.activationLimit);
  });

  it('honors a cap pinned below the base, so a pinned seed limit still pins', () => {
    expect(seedBudget(POPULATED_SUBSTRATE, { base: 10, growth: 2, cap: 1 })).toBe(1);
  });

  it('reads an unusable count as an empty substrate rather than as a huge one', () => {
    expect(seedBudget(Number.NaN, CURVE)).toBe(CURVE.base);
    expect(seedBudget(-40, CURVE)).toBe(CURVE.base);
  });
});

describe('legReservations', () => {
  it('gives every leg at least one slot once the budget can seat them all', () => {
    const slots = legReservations(SEED_STRATEGIES.length);
    for (const strategy of SEED_STRATEGIES) {
      expect(slots[strategy]).toBeGreaterThanOrEqual(1);
    }
  });

  it('stands down when the budget cannot seat every leg, rather than favouring the first named', () => {
    const slots = legReservations(SEED_STRATEGIES.length - 1);
    expect(SEED_STRATEGIES.map((strategy) => slots[strategy]).every((count) => count === 0)).toBe(true);
  });

  it('leaves part of the budget for whatever scored best overall', () => {
    for (const budget of [10, 20, 28, 32]) {
      const slots = legReservations(budget);
      const reserved = SEED_STRATEGIES.reduce((total, strategy) => total + slots[strategy], 0);
      expect(reserved).toBeLessThan(budget);
    }
  });

  it('reserves the most for the leg that measures how well a node answers the query', () => {
    const slots = legReservations(20);
    expect(slots.vector).toBeGreaterThan(slots.bm25);
    expect(slots.vector).toBeGreaterThan(slots.entity_resolution);
    expect(slots.vector).toBeGreaterThan(slots.recency);
    expect(LEG_RESERVATION_SHARES.vector).toBeGreaterThan(LEG_RESERVATION_SHARES.bm25);
  });
});

describe('roundRobinByCue', () => {
  const wide = [
    seed('wide-1', 'vector', 0.9, 'the checkout outage'),
    seed('wide-2', 'vector', 0.88, 'the checkout outage'),
    seed('wide-3', 'vector', 0.86, 'the checkout outage'),
    seed('narrow-1', 'vector', 0.7, 'the orders index'),
    seed('narrow-2', 'vector', 0.62, 'the orders index'),
  ];

  it('deals one cue at a time, so a broad cue cannot take every slot its leg holds', () => {
    expect(roundRobinByCue(wide, 'vector').map((entry) => entry.id)).toEqual([
      'wide-1',
      'narrow-1',
      'wide-2',
      'narrow-2',
      'wide-3',
    ]);
  });

  it('keeps each cue’s own ranking', () => {
    const dealt = roundRobinByCue(wide, 'vector').map((entry) => entry.id);
    expect(dealt.indexOf('wide-1')).toBeLessThan(dealt.indexOf('wide-2'));
    expect(dealt.indexOf('narrow-1')).toBeLessThan(dealt.indexOf('narrow-2'));
  });

  it('leaves a leg no cue drove in its own order', () => {
    const recent = [seed('r1', 'recency', 1), seed('r2', 'recency', 0.5)];
    expect(roundRobinByCue(recent, 'recency').map((entry) => entry.id)).toEqual(['r1', 'r2']);
  });

  it('returns nothing for a leg that found nothing', () => {
    expect(roundRobinByCue([], 'vector')).toEqual([]);
  });
});

describe('selectWithReservations', () => {
  // An exact name match, a BM25 list normalized to its own best hit, and the most recently
  // touched node all score 1.0 by construction. A cosine that answers the question arrives
  // well below that, so on score alone the answer never becomes a candidate.
  const lexical = Array.from({ length: 12 }, (_, index) =>
    seed(`bm25-${String(index)}`, 'bm25', 1 - index * 0.01, 'checkout latency'),
  );
  const recent = Array.from({ length: 6 }, (_, index) =>
    seed(`recency-${String(index)}`, 'recency', 1 / (1 + index)),
  );
  const semantic = [
    seed('answer', 'vector', 0.72, 'how did we fix the checkout latency'),
    seed('supporting', 'vector', 0.6, 'how did we fix the checkout latency'),
  ];

  const lists = byStrategy({ bm25: lexical, recency: recent, vector: semantic });
  const all = ranked(lexical, recent, semantic);

  it('keeps the answering vector hit that the lexical and recency legs would have crowded out', () => {
    const budget = 10;

    expect(all.slice(0, budget).map((entry) => entry.id)).not.toContain('answer');
    expect(selectWithReservations({ ranked: all, byStrategy: lists, budget }).map((s) => s.id)).toContain(
      'answer',
    );
  });

  it('spends exactly the budget when there are candidates for it', () => {
    for (const budget of [4, 10, 20]) {
      expect(selectWithReservations({ ranked: all, byStrategy: lists, budget })).toHaveLength(budget);
    }
  });

  it('returns the survivors in merged rank order, whichever leg reserved them', () => {
    const chosen = selectWithReservations({ ranked: all, byStrategy: lists, budget: 12 });
    const scores = chosen.map((entry) => entry.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  it('charges a node two legs found to one slot', () => {
    const shared = seed('shared', 'vector', 0.9, 'one cue');
    const chosen = selectWithReservations({
      ranked: ranked([shared], lexical),
      byStrategy: byStrategy({ vector: [shared], bm25: [shared, ...lexical] }),
      budget: 6,
    });

    expect(chosen).toHaveLength(6);
    expect(chosen.filter((entry) => entry.id === 'shared')).toHaveLength(1);
  });

  it('gives a leg no reservation back to the ranking rather than leaving the budget short', () => {
    const chosen = selectWithReservations({
      ranked: ranked(lexical),
      byStrategy: byStrategy({ bm25: lexical }),
      budget: 8,
    });
    expect(chosen).toHaveLength(8);
  });

  it('keeps a node only the context index ranked well, which the content leg buries', () => {
    // Both legs score on the query-against-content cosine, so a node the content index ranks
    // outside its own reserved rows loses to every row above it in a merged list, however
    // highly the context index ranked it. Measured live: the nodes stating a fix sat at ranks
    // 1 to 5 by neighborhood and 12, 15 and 19 by content, all above the admission floor.
    const buriedByContent = Array.from({ length: 12 }, (_, index) =>
      seed(`content-${String(index)}`, 'vector', 0.82 - index * 0.005, 'how did we fix it'),
    );
    const foundByContext = [
      seed('states-the-fix', 'context_vector', 0.73, 'how did we fix it'),
      seed('states-the-outcome', 'context_vector', 0.72, 'how did we fix it'),
    ];

    const chosen = selectWithReservations({
      ranked: ranked(buriedByContent, foundByContext),
      byStrategy: byStrategy({ vector: [...buriedByContent, ...foundByContext], context_vector: foundByContext }),
      budget: 12,
    }).map((entry) => entry.id);

    expect(chosen).toContain('states-the-fix');
    expect(chosen).toContain('states-the-outcome');
  });

  it('takes the best-scoring seeds when the budget cannot seat every leg', () => {
    const chosen = selectWithReservations({ ranked: all, byStrategy: lists, budget: 3 });
    expect(chosen.map((entry) => entry.id)).toEqual(all.slice(0, 3).map((entry) => entry.id));
  });

  it('returns nothing on a budget of zero', () => {
    expect(selectWithReservations({ ranked: all, byStrategy: lists, budget: 0 })).toEqual([]);
  });
});

function candidate(id: string, why?: string): SeedCandidate {
  return {
    id,
    labels: ['Decision', 'Memory', 'AionNode'],
    content: `content of ${id}`,
    currency: 'current',
    ...(why === undefined ? {} : { why }),
  };
}

function contribution(candidate: SeedCandidate, score: number): SeedContribution {
  return { candidate, strategy: 'vector', score, relevance: score };
}

describe('mergeSeeds', () => {
  it("carries a candidate's own reason through onto the merged seed", () => {
    const [merged] = mergeSeeds(
      [contribution(candidate('d1', 'because Postgres already owns the lock'), 0.8)],
      10,
    );

    expect(merged?.why).toBe('because Postgres already owns the lock');
  });

  it('leaves why absent for a candidate whose node stores no rationale', () => {
    const [merged] = mergeSeeds([contribution(candidate('e1'), 0.8)], 10);

    expect(merged?.why).toBeUndefined();
  });
});
