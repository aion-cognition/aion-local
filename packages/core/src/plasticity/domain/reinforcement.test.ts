import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRIGGER_POLICY,
  RECALL_CO_ACTIVATION_TRIGGER,
  REFLECTION_CO_EXTRACTION_TRIGGER,
  TRIGGER_POLICIES,
  aggregateWindow,
  boundedReinforcement,
  cliqueDiscount,
  cliqueSizes,
  pairKey,
  signalGroupKey,
  signalWeight,
  triggerPolicy,
} from './reinforcement.js';

const FLOOR = 0.1;
const BASE_RATE = 0.1;
const TS = '2026-01-01T00:00:00.000Z';

function recallSignal(sourceId: string, targetId: string, ts = TS) {
  return { sourceId, targetId, trigger: RECALL_CO_ACTIVATION_TRIGGER, ts };
}

function coExtractionSignal(sourceId: string, targetId: string, ts = TS) {
  return { sourceId, targetId, trigger: REFLECTION_CO_EXTRACTION_TRIGGER, ts };
}

/** Every unordered pair of the ids, the shape both producers enqueue. */
function clique(ids: readonly string[], ts = TS) {
  const signals = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      signals.push(coExtractionSignal(ids[i]!, ids[j]!, ts));
    }
  }
  return signals;
}

describe('trigger strings carry a policy', () => {
  it('gives the string each producer writes a row in the table', () => {
    expect(Object.keys(TRIGGER_POLICIES).sort()).toEqual(
      [RECALL_CO_ACTIVATION_TRIGGER, REFLECTION_CO_EXTRACTION_TRIGGER].sort(),
    );
  });
});

describe('bounded reinforcement', () => {
  it('climbs toward one and never past it', () => {
    let weight = FLOOR;
    let previous = weight;
    for (let step = 0; step < 500; step += 1) {
      weight = boundedReinforcement(weight, BASE_RATE, FLOOR);
      expect(weight).toBeLessThanOrEqual(1);
      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
    expect(weight).toBeGreaterThan(0.999);
  });

  it('is still strictly rising while the edge is short of saturation', () => {
    let weight = FLOOR;
    for (let step = 0; step < 50; step += 1) {
      const next = boundedReinforcement(weight, BASE_RATE, FLOOR);
      expect(next).toBeGreaterThan(weight);
      weight = next;
    }
  });

  it('gains less the stronger the edge already is', () => {
    const weak = boundedReinforcement(0.5, BASE_RATE, FLOOR) - 0.5;
    const strong = boundedReinforcement(0.9, BASE_RATE, FLOOR) - 0.9;
    expect(weak).toBeCloseTo(0.05, 10);
    expect(strong).toBeCloseTo(0.01, 10);
    expect(strong).toBeLessThan(weak);
  });

  it('stays inside the floor and one for every weight and rate in range', () => {
    for (let weight = 0; weight <= 1.0001; weight += 0.05) {
      for (let eta = 0; eta <= 1.0001; eta += 0.05) {
        const next = boundedReinforcement(Math.min(weight, 1), Math.min(eta, 1), FLOOR);
        expect(next).toBeGreaterThanOrEqual(FLOOR);
        expect(next).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never moves a weight downward', () => {
    for (let weight = FLOOR; weight <= 1.0001; weight += 0.05) {
      const start = Math.min(weight, 1);
      expect(boundedReinforcement(start, BASE_RATE, FLOOR)).toBeGreaterThanOrEqual(start);
    }
  });

  it('raises a weight found below the floor up to it', () => {
    expect(boundedReinforcement(0.01, 0, FLOOR)).toBe(FLOOR);
    expect(boundedReinforcement(0, 0.05, FLOOR)).toBe(FLOOR);
  });

  it('leaves a saturated edge alone', () => {
    expect(boundedReinforcement(1, BASE_RATE, FLOOR)).toBe(1);
    expect(boundedReinforcement(1, 1, FLOOR)).toBe(1);
  });
});

describe('per-trigger learning rates', () => {
  it('gives recall co-activation the full rate and no clique discount', () => {
    expect(triggerPolicy(RECALL_CO_ACTIVATION_TRIGGER)).toEqual({
      etaFactor: 1,
      cliqueDiscounted: false,
    });
  });

  it('gives reflection co-extraction three tenths of the rate', () => {
    expect(triggerPolicy(REFLECTION_CO_EXTRACTION_TRIGGER).etaFactor).toBeCloseTo(0.3, 10);
  });

  it('applies the co-extraction factor as 0.03 against the pinned base rate', () => {
    const [pair] = aggregateWindow([coExtractionSignal('a', 'b')], BASE_RATE);
    expect(pair?.learningRate).toBeCloseTo(0.03, 10);
  });

  it('falls back to the full rate for a trigger nobody registered', () => {
    expect(triggerPolicy('manual:correction')).toEqual({ etaFactor: 1, cliqueDiscounted: false });
  });

  it('falls back for a trigger that spells an inherited Object member', () => {
    expect(triggerPolicy('constructor')).toEqual(DEFAULT_TRIGGER_POLICY);
    expect(triggerPolicy('toString')).toEqual(DEFAULT_TRIGGER_POLICY);
  });

  it('keeps a step for a queue row whose trigger spells an inherited member', () => {
    const [pair] = aggregateWindow(
      [{ sourceId: 'a', targetId: 'b', trigger: 'constructor', ts: TS }],
      BASE_RATE,
    );
    expect(pair?.learningRate).toBeCloseTo(BASE_RATE, 10);
  });
});

describe('clique discount', () => {
  it('leaves a pair undiscounted', () => {
    expect(cliqueDiscount(2)).toBe(1);
  });

  it('divides a single node of evidence across the partners the burst gave it', () => {
    expect(cliqueDiscount(3)).toBeCloseTo(0.5, 10);
    expect(cliqueDiscount(11)).toBeCloseTo(0.1, 10);
    expect(cliqueDiscount(32)).toBeCloseTo(1 / 31, 10);
  });

  it('never divides by zero on a degenerate group', () => {
    expect(cliqueDiscount(1)).toBe(1);
    expect(cliqueDiscount(0)).toBe(1);
  });

  it('keeps the total signal of a burst linear in its size rather than quadratic', () => {
    const small = clique(['a', 'b', 'c']);
    const large = clique(['a', 'b', 'c', 'd', 'e', 'f']);
    const total = (signals: ReturnType<typeof clique>) =>
      aggregateWindow(signals, BASE_RATE).reduce((sum, pair) => sum + pair.effectiveSignal, 0);

    expect(total(large) / total(small)).toBeCloseTo(2, 10);
  });

  it('counts the burst from its distinct endpoints', () => {
    const sizes = cliqueSizes(clique(['a', 'b', 'c', 'd']));
    expect([...sizes.values()]).toEqual([4]);
  });

  it('separates bursts by trigger and timestamp', () => {
    const sizes = cliqueSizes([
      ...clique(['a', 'b', 'c']),
      ...clique(['d', 'e'], '2026-01-02T00:00:00.000Z'),
      recallSignal('f', 'g'),
    ]);
    expect(sizes.size).toBe(3);
    expect(sizes.get(signalGroupKey({ trigger: RECALL_CO_ACTIVATION_TRIGGER, ts: TS }))).toBe(2);
  });

  it('discounts a co-extraction signal but not a recall one', () => {
    expect(signalWeight(coExtractionSignal('a', 'b'), 11)).toBeCloseTo(0.03, 10);
    expect(signalWeight(recallSignal('a', 'b'), 11)).toBe(1);
  });
});

describe('window aggregation', () => {
  it('folds repeated signals for one pair into a single bounded step', () => {
    const once = aggregateWindow([recallSignal('a', 'b')], BASE_RATE);
    const tenTimes = aggregateWindow(
      Array.from({ length: 10 }, (_, index) =>
        recallSignal('a', 'b', `2026-01-01T00:00:0${String(index)}.000Z`),
      ),
      BASE_RATE,
    );

    expect(tenTimes).toHaveLength(1);
    expect(tenTimes[0]?.signalCount).toBe(10);
    expect(tenTimes[0]?.effectiveSignal).toBe(10);
    expect(tenTimes[0]?.learningRate).toBe(once[0]?.learningRate);
    expect(tenTimes[0]?.learningRate).toBeCloseTo(BASE_RATE, 10);
  });

  it('moves a weight no further than one full-rate step however many signals arrive', () => {
    const flood = aggregateWindow(
      Array.from({ length: 500 }, () => recallSignal('a', 'b')),
      BASE_RATE,
    );
    const applied = boundedReinforcement(0.5, flood[0]?.learningRate ?? 0, FLOOR);
    expect(applied).toBeCloseTo(boundedReinforcement(0.5, BASE_RATE, FLOOR), 10);
  });

  it('accumulates weak co-extraction signals toward the full rate without passing it', () => {
    const pairs = aggregateWindow(
      Array.from({ length: 3 }, (_, index) =>
        coExtractionSignal('a', 'b', `2026-01-01T00:00:0${String(index)}.000Z`),
      ),
      BASE_RATE,
    );
    expect(pairs[0]?.learningRate).toBeCloseTo(0.09, 10);
    expect(pairs[0]?.learningRate).toBeLessThanOrEqual(BASE_RATE);
  });

  it('folds both endpoint orders of one pair together', () => {
    const pairs = aggregateWindow([recallSignal('b', 'a'), recallSignal('a', 'b')], BASE_RATE);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ sourceId: 'a', targetId: 'b', signalCount: 2 });
  });

  it('orders pairs the same way for the same window whatever order the rows arrived in', () => {
    const forward = aggregateWindow(
      [recallSignal('c', 'd'), recallSignal('a', 'b'), recallSignal('e', 'f')],
      BASE_RATE,
    );
    const reversed = aggregateWindow(
      [recallSignal('e', 'f'), recallSignal('a', 'b'), recallSignal('d', 'c')],
      BASE_RATE,
    );
    expect(forward.map((pair) => pairKey(pair.sourceId, pair.targetId))).toEqual(
      reversed.map((pair) => pairKey(pair.sourceId, pair.targetId)),
    );
  });

  it('drops a self-pair', () => {
    expect(aggregateWindow([recallSignal('a', 'a')], BASE_RATE)).toEqual([]);
  });

  it('returns nothing for an empty window', () => {
    expect(aggregateWindow([], BASE_RATE)).toEqual([]);
  });

  it('mixes triggers on one pair by summing what each is worth', () => {
    const pairs = aggregateWindow(
      [recallSignal('a', 'b'), ...clique(['a', 'b', 'c'], '2026-01-02T00:00:00.000Z')],
      BASE_RATE,
    );
    const target = pairs.find(
      (pair) => pairKey(pair.sourceId, pair.targetId) === pairKey('a', 'b'),
    );
    expect(target?.signalCount).toBe(2);
    expect(target?.effectiveSignal).toBeCloseTo(1.15, 10);
    expect(target?.learningRate).toBeCloseTo(BASE_RATE, 10);
  });
});
