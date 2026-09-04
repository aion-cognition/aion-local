import { describe, expect, it } from 'vitest';

import { expectedBoundedDecay, expectedDecayFactor } from './decay.oracle.js';

const PEAK = 30;
const SIGMA = 15;
const RATE = 0.05;
const FLOOR = 0.1;

describe('bell curve decay factor', () => {
  it('peaks at the configured peak day', () => {
    expect(expectedDecayFactor(PEAK, PEAK, SIGMA)).toBeCloseTo(1, 10);
  });

  it('decays a recently touched edge slower than one at the peak', () => {
    const peak = expectedDecayFactor(PEAK, PEAK, SIGMA);
    expect(expectedDecayFactor(0, PEAK, SIGMA)).toBeLessThan(peak);
    expect(expectedDecayFactor(5, PEAK, SIGMA)).toBeLessThan(peak);
  });

  it('decays an edge long past the peak slower than one at the peak', () => {
    const peak = expectedDecayFactor(PEAK, PEAK, SIGMA);
    expect(expectedDecayFactor(200, PEAK, SIGMA)).toBeLessThan(peak);
    expect(expectedDecayFactor(365, PEAK, SIGMA)).toBeLessThan(peak);
  });

  it('is symmetric around the peak', () => {
    for (let offset = 0; offset <= 60; offset += 5) {
      expect(expectedDecayFactor(PEAK - offset, PEAK, SIGMA)).toBeCloseTo(
        expectedDecayFactor(PEAK + offset, PEAK, SIGMA),
        10,
      );
    }
  });

  it('rises toward the peak and falls past it', () => {
    let previous = expectedDecayFactor(0, PEAK, SIGMA);
    for (let t = 1; t <= PEAK; t += 1) {
      const current = expectedDecayFactor(t, PEAK, SIGMA);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    for (let t = PEAK + 5; t <= PEAK + 200; t += 5) {
      const current = expectedDecayFactor(t, PEAK, SIGMA);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  it('stays inside zero and one for a wide range of staleness', () => {
    // The tails underflow to exactly 0 in double precision past roughly 700 days from the
    // peak (exp(-745) is IEEE754's floor), which is the curve doing its job, not a bug.
    for (let t = -100; t <= 1000; t += 10) {
      const factor = expectedDecayFactor(t, PEAK, SIGMA);
      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
  });
});

describe('bounded decay', () => {
  it('never moves a weight upward', () => {
    for (let weight = FLOOR; weight <= 1.0001; weight += 0.05) {
      const start = Math.min(weight, 1);
      const factor = expectedDecayFactor(PEAK, PEAK, SIGMA);
      expect(expectedBoundedDecay(start, RATE, factor, FLOOR)).toBeLessThanOrEqual(start);
    }
  });

  it('never crosses the floor for any weight at or above it', () => {
    for (let weight = FLOOR; weight <= 1.0001; weight += 0.1) {
      for (let factor = 0; factor <= 1.0001; factor += 0.1) {
        const next = expectedBoundedDecay(Math.min(weight, 1), RATE, Math.min(factor, 1), FLOOR);
        expect(next).toBeGreaterThanOrEqual(FLOOR);
      }
    }
  });

  it('leaves an edge stored under the floor where it is rather than raising it', () => {
    // A semantic relationship writes its confidence as its strength unclamped, so a weak
    // proposal sits under the floor. The sweep must not be what makes it traversable.
    expect(expectedBoundedDecay(0.05, RATE, 1, FLOOR)).toBe(0.05);
    expect(expectedBoundedDecay(0, RATE, 1, FLOOR)).toBe(0);
  });

  it('leaves a weight already at the floor exactly there at the peak decay rate', () => {
    expect(expectedBoundedDecay(FLOOR, RATE, 1, FLOOR)).toBe(FLOOR);
  });

  it('takes the largest step at the peak, given equal starting weight', () => {
    const start = 0.5;
    const atPeak = expectedBoundedDecay(start, RATE, expectedDecayFactor(PEAK, PEAK, SIGMA), FLOOR);
    const recent = expectedBoundedDecay(start, RATE, expectedDecayFactor(0, PEAK, SIGMA), FLOOR);
    const ancient = expectedBoundedDecay(start, RATE, expectedDecayFactor(300, PEAK, SIGMA), FLOOR);
    expect(start - atPeak).toBeGreaterThan(start - recent);
    expect(start - atPeak).toBeGreaterThan(start - ancient);
  });

  it('takes no step when the factor is zero', () => {
    expect(expectedBoundedDecay(0.5, RATE, 0, FLOOR)).toBe(0.5);
  });
});
