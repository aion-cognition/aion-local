import { describe, expect, it } from 'vitest';

import { scoreArrivals } from './arrival-scoring.js';
import type { Vector } from '../../infrastructure/providers/types.js';

/** Unit axes, so every expected cosine is exact rather than approximate. */
function axis(index: number): Vector {
  const vector = [0, 0, 0, 0];
  vector[index] = 1;
  return vector;
}

/** Half way between two axes: cosine 0.707 against either, which is above the shipped floor. */
function between(first: number, second: number): Vector {
  const vector = [0, 0, 0, 0];
  vector[first] = 1;
  vector[second] = 1;
  return vector;
}

const OUTBOX = { text: 'outbox table', vector: axis(0) };
const REMITTANCE = { text: 'remittance ingest', vector: axis(1) };

describe('scoring what the spread reached', () => {
  it('measures each arrival against each embedded cue', () => {
    const scored = scoreArrivals({
      arrivals: ['reached'],
      vectors: new Map([['reached', between(0, 1)]]),
      cues: [OUTBOX, REMITTANCE],
    });

    const measurements = scored.get('reached') ?? [];
    expect(measurements.map((measurement) => [measurement.method, measurement.cue])).toEqual([
      ['vector', 'outbox table'],
      ['vector', 'remittance ingest'],
    ]);
    expect(measurements[0]?.relevance).toBeCloseTo(0.7071, 4);
    expect(measurements[1]?.relevance).toBeCloseTo(0.7071, 4);
  });

  it('records the measurement even when it comes out at nothing, so the drop is attributable', () => {
    const scored = scoreArrivals({
      arrivals: ['unrelated'],
      vectors: new Map([['unrelated', axis(3)]]),
      cues: [OUTBOX],
    });

    expect(scored.get('unrelated')).toEqual([
      { method: 'vector', relevance: 0, cue: 'outbox table' },
    ]);
  });

  it('leaves out an arrival whose content vector is still pending', () => {
    const scored = scoreArrivals({
      arrivals: ['reached', 'pending'],
      vectors: new Map([['reached', axis(0)]]),
      cues: [OUTBOX],
    });

    expect(scored.has('reached')).toBe(true);
    expect(scored.has('pending')).toBe(false);
  });

  it('measures nothing when the embedding stage left every cue without a vector', () => {
    const scored = scoreArrivals({
      arrivals: ['reached'],
      vectors: new Map([['reached', axis(0)]]),
      cues: [{ text: 'outbox table' }, { text: 'remittance ingest', vector: [] }],
    });

    expect(scored.size).toBe(0);
  });

  it('skips a cue with no vector and keeps the ones that have one', () => {
    const scored = scoreArrivals({
      arrivals: ['reached'],
      vectors: new Map([['reached', axis(0)]]),
      cues: [{ text: 'bare cue' }, OUTBOX],
    });

    expect(scored.get('reached')).toEqual([
      { method: 'vector', relevance: 1, cue: 'outbox table' },
    ]);
  });

  it('measures nothing when the spread reached nothing of its own', () => {
    expect(scoreArrivals({ arrivals: [], vectors: new Map(), cues: [OUTBOX] }).size).toBe(0);
  });
});
