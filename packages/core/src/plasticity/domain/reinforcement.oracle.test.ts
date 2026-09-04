import { describe, expect, it } from 'vitest';

import { expectedBoundedReinforcement } from './reinforcement.oracle.js';

const FLOOR = 0.1;
const BASE_RATE = 0.1;

describe('bounded reinforcement', () => {
  it('climbs toward one and never past it', () => {
    let weight = FLOOR;
    let previous = weight;
    for (let step = 0; step < 500; step += 1) {
      weight = expectedBoundedReinforcement(weight, BASE_RATE, FLOOR);
      expect(weight).toBeLessThanOrEqual(1);
      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
    expect(weight).toBeGreaterThan(0.999);
  });

  it('is still strictly rising while the edge is short of saturation', () => {
    let weight = FLOOR;
    for (let step = 0; step < 50; step += 1) {
      const next = expectedBoundedReinforcement(weight, BASE_RATE, FLOOR);
      expect(next).toBeGreaterThan(weight);
      weight = next;
    }
  });

  it('gains less the stronger the edge already is', () => {
    const weak = expectedBoundedReinforcement(0.5, BASE_RATE, FLOOR) - 0.5;
    const strong = expectedBoundedReinforcement(0.9, BASE_RATE, FLOOR) - 0.9;
    expect(weak).toBeCloseTo(0.05, 10);
    expect(strong).toBeCloseTo(0.01, 10);
    expect(strong).toBeLessThan(weak);
  });

  it('stays inside the floor and one for every weight and rate in range', () => {
    for (let weight = 0; weight <= 1.0001; weight += 0.05) {
      for (let eta = 0; eta <= 1.0001; eta += 0.05) {
        const next = expectedBoundedReinforcement(Math.min(weight, 1), Math.min(eta, 1), FLOOR);
        expect(next).toBeGreaterThanOrEqual(FLOOR);
        expect(next).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never moves a weight downward', () => {
    for (let weight = FLOOR; weight <= 1.0001; weight += 0.05) {
      const start = Math.min(weight, 1);
      expect(expectedBoundedReinforcement(start, BASE_RATE, FLOOR)).toBeGreaterThanOrEqual(start);
    }
  });

  it('raises a weight found below the floor up to it', () => {
    expect(expectedBoundedReinforcement(0.01, 0, FLOOR)).toBe(FLOOR);
    expect(expectedBoundedReinforcement(0, 0.05, FLOOR)).toBe(FLOOR);
  });

  it('leaves a saturated edge alone', () => {
    expect(expectedBoundedReinforcement(1, BASE_RATE, FLOOR)).toBe(1);
    expect(expectedBoundedReinforcement(1, 1, FLOOR)).toBe(1);
  });
});
