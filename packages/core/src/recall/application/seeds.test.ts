import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  SEED_STRATEGIES,
  SEED_STRATEGY_METHODS,
  RECENCY_RELEVANCE,
  mergeSeeds,
  normalizeToBest,
  recencyScore,
  scaleByCueWeight,
  selectSeeds,
  type SeedContribution,
  type SeedSelection,
  type SeedStrategy,
} from './seeds.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type {
  ScoredSeedCandidate,
  SeedCandidate,
} from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';

function candidate(id: string, content = `content ${id}`): SeedCandidate {
  return { id, labels: ['Episode', 'Memory', 'AionNode'], content, currency: 'current' };
}

function scored(id: string, score: number): ScoredSeedCandidate {
  return { ...candidate(id), score };
}

function contribution(
  id: string,
  strategy: SeedStrategy,
  score: number,
  cue?: string,
  relevance = strategy === 'recency' ? RECENCY_RELEVANCE : score,
): SeedContribution {
  const base = { candidate: candidate(id), strategy, score, relevance };
  return cue === undefined ? base : { ...base, cue };
}

describe('scaleByCueWeight', () => {
  it('leaves a query cue at full strength and thins the weaker buckets', () => {
    expect(scaleByCueWeight(1, 3)).toBe(1);
    expect(scaleByCueWeight(1, 2)).toBeCloseTo(2 / 3);
    expect(scaleByCueWeight(1, 1)).toBeCloseTo(1 / 3);
  });

  it('scales proportionally, so within one weight the strategy ranking is unchanged', () => {
    expect(scaleByCueWeight(0.9, 2)).toBeGreaterThan(scaleByCueWeight(0.8, 2));
    expect(scaleByCueWeight(0.9, 1)).toBeLessThan(scaleByCueWeight(0.9, 3));
  });
});

describe('normalizeToBest', () => {
  it('puts an unbounded Lucene score on (0, 1] without reordering it', () => {
    const normalized = normalizeToBest([scored('a', 8.4), scored('b', 4.2), scored('c', 2.1)]);
    expect(normalized.map((seed) => seed.score)).toEqual([1, 0.5, 0.25]);
    expect(normalized.map((seed) => seed.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves an empty or all-zero list alone rather than dividing by zero', () => {
    expect(normalizeToBest([])).toEqual([]);
    expect(normalizeToBest([scored('a', 0)]).map((seed) => seed.score)).toEqual([0]);
  });
});

describe('recencyScore', () => {
  it('lets the most recent node compete and drops the tail away fast', () => {
    expect(recencyScore(0)).toBe(1);
    expect(recencyScore(1)).toBe(0.5);
    expect(recencyScore(3)).toBe(0.25);
    expect(recencyScore(9)).toBeCloseTo(0.1);
  });
});

describe('the two numbers a seed carries', () => {
  it('scales the ranking score by the cue weight and leaves the measurement alone', () => {
    const cosine = 0.9;
    const [seed] = mergeSeeds(
      [contribution('a', 'vector', scaleByCueWeight(cosine, 1), 'a recent turn', cosine)],
      10,
    );

    // A perfect match found by a 1x recent-turn cue: ranked last, still well clear of the
    // 0.35 floor. Scaling the two together would put it at 0.333 and delete the bucket.
    expect(seed?.score).toBeCloseTo(0.3);
    expect(seed?.relevance).toBe(cosine);
  });

  it('takes the strongest measurement any strategy made, not the one that ranked best', () => {
    const [seed] = mergeSeeds(
      [
        contribution('a', 'vector', scaleByCueWeight(0.6, 3), 'the query', 0.6),
        contribution('a', 'bm25', scaleByCueWeight(0.95, 1), 'a recent turn', 0.95),
      ],
      10,
    );

    expect(seed?.score).toBeCloseTo(0.6);
    expect(seed?.relevance).toBe(0.95);
  });

  it('measures nothing for recency, so a merely recent node cannot carry itself into a pack', () => {
    const [seed] = mergeSeeds([contribution('a', 'recency', recencyScore(0))], 10);

    expect(seed?.score).toBe(1);
    expect(seed?.relevance).toBe(0);
  });
});

describe('mergeSeeds', () => {
  it('dedupes by node id and keeps every strategy that found the node, best score first', () => {
    const [seed] = mergeSeeds(
      [
        contribution('a', 'recency', 0.25),
        contribution('a', 'vector', 0.82, 'reflection queue'),
        contribution('a', 'bm25', 0.4, 'reflection queue'),
      ],
      10,
    );

    expect(seed?.id).toBe('a');
    expect(seed?.score).toBe(0.82);
    expect(seed?.provenance).toEqual([
      { strategy: 'vector', score: 0.82, relevance: 0.82, cue: 'reflection queue' },
      { strategy: 'bm25', score: 0.4, relevance: 0.4, cue: 'reflection queue' },
      { strategy: 'recency', score: 0.25, relevance: RECENCY_RELEVANCE },
    ]);
  });

  it('omits the cue on a contribution no cue drove', () => {
    const [seed] = mergeSeeds([contribution('a', 'recency', 1)], 10);
    expect(seed?.provenance[0]).not.toHaveProperty('cue');
  });

  it('keeps two hits from different cues on the same strategy', () => {
    const [seed] = mergeSeeds(
      [contribution('a', 'vector', 0.7, 'first'), contribution('a', 'vector', 0.5, 'second')],
      10,
    );
    expect(seed?.provenance).toHaveLength(2);
    expect(seed?.provenance.map((entry) => entry.cue)).toEqual(['first', 'second']);
  });

  it('ranks by best score and cuts to the limit', () => {
    const merged = mergeSeeds(
      [
        contribution('low', 'vector', 0.2),
        contribution('high', 'vector', 0.9),
        contribution('mid', 'vector', 0.5),
      ],
      2,
    );
    expect(merged.map((seed) => seed.id)).toEqual(['high', 'mid']);
  });

  it('breaks a score tie toward the node more strategies corroborate', () => {
    const merged = mergeSeeds(
      [
        contribution('single', 'vector', 0.6),
        contribution('double', 'vector', 0.6),
        contribution('double', 'bm25', 0.6),
      ],
      10,
    );
    expect(merged.map((seed) => seed.id)).toEqual(['double', 'single']);
  });

  it('carries the candidate through unchanged, currency annotation included', () => {
    const supersededBy = { id: 'newer', at: new Date('2026-08-01T00:00:00.000Z') };
    const occurredAt = new Date('2026-07-01T00:00:00.000Z');
    const merged = mergeSeeds(
      [
        {
          candidate: {
            ...candidate('a', 'the old fact'),
            currency: 'superseded',
            supersededBy,
            occurredAt,
          },
          strategy: 'vector',
          score: 0.5,
          relevance: 0.5,
        },
      ],
      10,
    );

    expect(merged[0]).toMatchObject({
      content: 'the old fact',
      currency: 'superseded',
      supersededBy,
      occurredAt,
    });
  });

  it('returns nothing for no contributions or a zero limit', () => {
    expect(mergeSeeds([], 10)).toEqual([]);
    expect(mergeSeeds([contribution('a', 'vector', 1)], 0)).toEqual([]);
  });
});

describe('SEED_STRATEGIES', () => {
  it('names every way a seed can be found', () => {
    expect([...SEED_STRATEGIES]).toEqual([
      'vector',
      'context_vector',
      'bm25',
      'entity_resolution',
      'recency',
    ]);
  });

  it('reports the two vector indexes as one method, so one cosine cannot corroborate itself', () => {
    expect(SEED_STRATEGY_METHODS.context_vector).toBe(SEED_STRATEGY_METHODS.vector);
  });
});

const NO_ROWS = { records: [], summary: { counters: { updates: () => ({}) } } };

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function driverAnswering(answer: (cypher: string) => Promise<unknown>): Driver {
  return { executeQuery: (cypher: string) => answer(cypher) } as unknown as Driver;
}

function selectFrom(driver: Driver): Promise<SeedSelection> {
  return selectSeeds(
    { driver, config: DEFAULTS, logger: silentLogger() },
    { cues: [{ text: 'webhook ingestion', source: 'query', weight: 3, vector: [1, 0, 0] }] },
  );
}

type FakeRow = Record<string, unknown>;

function answeringWith(rows: (cypher: string, parameters: FakeRow) => readonly FakeRow[]): Driver {
  return {
    executeQuery: (cypher: string, parameters: FakeRow) =>
      Promise.resolve({
        records: rows(cypher, parameters).map((entry) => ({ toObject: () => entry })),
        summary: { counters: { updates: () => ({}) } },
      }),
  } as unknown as Driver;
}

function row(id: string, score: number): FakeRow {
  return {
    id,
    labels: ['Episode', 'Memory'],
    content: `content ${id}`,
    occurred_at: null,
    is_structural: null,
    source_episode_id: null,
    currency: 'current',
    superseded_by: null,
    score,
    name_norm: 'webhook ingestion',
  };
}

describe('what the legs mark as a literal match', () => {
  it('asks Lucene for the verbatim cue as well, and marks only that hit exact', async () => {
    const selection = await selectSeeds(
      { driver: answeringWith(fulltextRows), config: DEFAULTS, logger: silentLogger() },
      { cues: [{ text: 'webhook ingestion', source: 'query', weight: 3 }] },
    );

    const exact = selection.byStrategy.bm25.find((seed) => seed.id === 'phrase-hit');
    const loose = selection.byStrategy.bm25.find((seed) => seed.id === 'term-hit');
    expect(exact?.provenance[0]).toMatchObject({ strategy: 'bm25', exact: true });
    expect(loose?.provenance[0]).not.toHaveProperty('exact');
  });

  it('marks an exact entity-name resolution, which is an identity match rather than a score', async () => {
    const selection = await selectSeeds(
      {
        driver: answeringWith((cypher) =>
          cypher.includes('MATCH (n:Entity)') ? [row('e', 1)] : [],
        ),
        config: DEFAULTS,
        logger: silentLogger(),
      },
      { cues: [{ text: 'webhook ingestion', source: 'query', weight: 3 }] },
    );

    expect(selection.byStrategy.entity_resolution[0]?.provenance[0]).toMatchObject({
      strategy: 'entity_resolution',
      exact: true,
    });
  });
});

function fulltextRows(cypher: string, parameters: FakeRow): readonly FakeRow[] {
  if (!cypher.includes('db.index.fulltext.queryNodes')) {
    return [];
  }
  const { query } = parameters;
  if (typeof query === 'string' && query.startsWith('"')) {
    return [row('phrase-hit', 4.2)];
  }
  return [row('term-hit', 8.4)];
}

const POPULATION_QUERY = 'count(n) AS population';

function countingDriver(
  population: number | Error,
  onCount: () => void = () => {
    // Most tests don't care how many times the count query ran.
  },
): Driver {
  return {
    executeQuery: (cypher: string) => {
      if (!cypher.includes(POPULATION_QUERY)) {
        return Promise.resolve(NO_ROWS);
      }
      onCount();
      if (population instanceof Error) {
        return Promise.reject(population);
      }
      return Promise.resolve({
        records: [{ toObject: () => ({ population }) }],
        summary: { counters: { updates: () => ({}) } },
      });
    },
  } as unknown as Driver;
}

describe('the seed budget the substrate earns', () => {
  it('sizes the candidate set from the memory population and reports what it used', async () => {
    const small = await selectFrom(countingDriver(1));
    const large = await selectFrom(countingDriver(6600));

    expect(small.budget).toBe(DEFAULTS.contextResonance.seedBudgetBase);
    expect(large.budget).toBeGreaterThan(small.budget);
    expect(large.budget).toBeLessThanOrEqual(DEFAULTS.contextResonance.seedLimit);
  });

  it('counts the substrate once and reuses the reading for the next recall', async () => {
    let counts = 0;
    const driver = countingDriver(6600, () => {
      counts += 1;
    });

    await selectFrom(driver);
    await selectFrom(driver);

    expect(counts).toBe(1);
  });

  // A count is not a candidate, so losing it costs a smaller budget rather than a recall.
  it('falls back to the base budget when the count fails and the legs answer', async () => {
    const selection = await selectFrom(countingDriver(new Error('ServiceUnavailable')));

    expect(selection.budget).toBe(DEFAULTS.contextResonance.seedBudgetBase);
    expect(selection.graphUnavailable).toBe(false);
  });
});

describe('selectSeeds when the graph is not answering', () => {
  it('flags the graph unavailable when every query it issued was rejected', async () => {
    const selection = await selectFrom(
      driverAnswering(() => Promise.reject(new Error('ServiceUnavailable: connect ECONNREFUSED'))),
    );

    expect(selection.graphUnavailable).toBe(true);
    expect(selection.seeds).toEqual([]);
  });

  // The state this separates from the one above: a live graph that holds nothing produces
  // the same empty seed list, and calling that an outage would be the opposite lie.
  it('leaves the flag down when the queries answered with no rows', async () => {
    const selection = await selectFrom(driverAnswering(() => Promise.resolve(NO_ROWS)));

    expect(selection.graphUnavailable).toBe(false);
    expect(selection.seeds).toEqual([]);
  });

  it('leaves the flag down when one leg failed and the rest answered', async () => {
    const selection = await selectFrom(
      driverAnswering((cypher) =>
        cypher.includes('db.index.fulltext.queryNodes')
          ? Promise.reject(new Error('lucene parse error'))
          : Promise.resolve(NO_ROWS),
      ),
    );

    expect(selection.graphUnavailable).toBe(false);
  });
});
