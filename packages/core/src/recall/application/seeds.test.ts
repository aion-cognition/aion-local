import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { ScoredSeedCandidate, SeedCandidate } from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import {
  SEED_STRATEGIES,
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
    expect(normalized.map((row) => row.score)).toEqual([1, 0.5, 0.25]);
    expect(normalized.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves an empty or all-zero list alone rather than dividing by zero', () => {
    expect(normalizeToBest([])).toEqual([]);
    expect(normalizeToBest([scored('a', 0)]).map((row) => row.score)).toEqual([0]);
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
  it('names the whitepaper §5.2 four, each a RecallMethod fusion can put in a rationale', () => {
    expect([...SEED_STRATEGIES]).toEqual(['vector', 'bm25', 'entity_resolution', 'recency']);
  });
});

const NO_ROWS = { records: [], summary: { counters: { updates: () => ({}) } } };

function silentLogger(): Logger {
  const noop = (): void => {};
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
