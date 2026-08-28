import { describe, expect, it } from 'vitest';
import type { ScoredSeedCandidate, SeedCandidate } from '../graph/seed-queries.js';
import {
  SEED_STRATEGIES,
  mergeSeeds,
  normalizeToBest,
  recencyScore,
  scaleByCueWeight,
  type SeedContribution,
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
): SeedContribution {
  const base = { candidate: candidate(id), strategy, score };
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
      { strategy: 'vector', score: 0.82, cue: 'reflection queue' },
      { strategy: 'bm25', score: 0.4, cue: 'reflection queue' },
      { strategy: 'recency', score: 0.25 },
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
