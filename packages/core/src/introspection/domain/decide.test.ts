import { describe, expect, it } from 'vitest';

import {
  costDivisor,
  CRITICAL_PREEMPTION_GRACE_RUNS,
  decide,
  DEPRIORITIZED_WEIGHT,
  scoreCandidate,
  starvationBoost,
  type CostScale,
  type DecisionInput,
  type OperationCandidate,
} from './decide.js';
import {
  CRITICAL_MIN_POPULATION,
  criticalConditions,
  HEALTH_COLLECTORS,
  NEUTRAL_GRAPH_HEALTH,
  type OperationEffectiveness,
} from './health.js';
import { healthFixture } from './test-support/health.fixture.js';

const POPULATION = CRITICAL_MIN_POPULATION * 5;

/** The shipped scale, written out here so a reading below is arguable from the numbers. */
const COST: CostScale = { referenceMs: 1_000, decades: 3, maxDivisor: 2 };

function baseInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    health: healthFixture(),
    candidates: [],
    starvationCycles: 8,
    urgencyThreshold: 0.2,
    effectivenessFloor: 0.5,
    cost: COST,
    tier3Enabled: false,
    ...overrides,
  };
}

function stats(overrides: Partial<OperationEffectiveness>): OperationEffectiveness {
  return {
    name: 'routine',
    runs: 0,
    improved: 0,
    failed: 0,
    effectiveness: 1,
    cyclesSinceSelected: 0,
    lastRunAt: undefined,
    meanDurationMs: undefined,
    ...overrides,
  };
}

function candidate(overrides: Partial<OperationCandidate>): OperationCandidate {
  return { name: 'routine', relevance: 0.5, ...overrides };
}

describe('criticalConditions', () => {
  it('reports nothing on a healthy substrate', () => {
    expect(criticalConditions(healthFixture())).toEqual([]);
  });

  it('reports a parity gap only once the population is worth measuring', () => {
    const small = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, vectorExpected: 5, vectorPresent: 3, vectorParity: 0.6 },
    });
    expect(criticalConditions(small)).toEqual([]);

    const real = healthFixture({
      graph: {
        ...NEUTRAL_GRAPH_HEALTH,
        vectorExpected: POPULATION,
        vectorPresent: POPULATION / 2,
        vectorParity: 0.5,
      },
    });
    expect(criticalConditions(real)).toEqual(['vector_parity']);
  });

  it('reports an orphan explosion above the share', () => {
    const health = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, nodes: POPULATION, orphanShare: 0.6 },
    });
    expect(criticalConditions(health)).toEqual(['orphan_share']);
  });

  it('reports a single missing backbone link', () => {
    const health = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, episodesWithoutSession: 1 },
    });
    expect(criticalConditions(health)).toEqual(['missing_backbone_links']);
  });

  it('reports nothing when the graph collector fell back', () => {
    const health = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, episodesWithoutSession: 12 },
      degraded: [HEALTH_COLLECTORS.graph],
    });
    expect(criticalConditions(health)).toEqual([]);
  });
});

describe('starvationBoost', () => {
  it('is one for an operation selected this cycle', () => {
    expect(starvationBoost(0, 8)).toBe(1);
  });

  it('doubles across the configured span and keeps rising past it', () => {
    expect(starvationBoost(8, 8)).toBe(2);
    expect(starvationBoost(24, 8)).toBe(4);
  });

  it('leaves an operation with nothing to do at zero urgency however long it waits', () => {
    const scored = scoreCandidate(
      candidate({ relevance: 0 }),
      baseInput({
        health: healthFixture({ effectiveness: [stats({ cyclesSinceSelected: 500 })] }),
      }),
    );
    expect(scored.urgency).toBe(0);
  });
});

describe('scoreCandidate', () => {
  it('halves urgency for an operation under the effectiveness floor', () => {
    const input = baseInput({
      health: healthFixture({
        effectiveness: [stats({ runs: 10, improved: 1, effectiveness: 0.1 })],
      }),
    });
    expect(scoreCandidate(candidate({}), input).urgency).toBeCloseTo(0.5 * DEPRIORITIZED_WEIGHT, 6);
  });

  it('leaves an operation with no history unweighted rather than scoring it', () => {
    const scored = scoreCandidate(candidate({ name: 'never-run' }), baseInput());
    expect(scored.effectiveness).toBeUndefined();
    expect(scored.urgency).toBeCloseTo(0.5, 6);
  });

  it('leaves an operation whose record no metric scored unweighted', () => {
    const input = baseInput({
      health: healthFixture({
        effectiveness: [stats({ runs: 10, improved: 0, effectiveness: undefined })],
      }),
    });
    const scored = scoreCandidate(candidate({}), input);
    expect(scored.effectiveness).toBeUndefined();
    expect(scored.urgency).toBeCloseTo(0.5, 6);
  });

  it('divides urgency by a bounded cost term, never to zero', () => {
    const dear = baseInput({
      health: healthFixture({
        effectiveness: [stats({ runs: 4, improved: 4, effectiveness: 1, meanDurationMs: 600_000 })],
      }),
    });
    const cheap = baseInput({
      health: healthFixture({
        effectiveness: [stats({ runs: 4, improved: 4, effectiveness: 1, meanDurationMs: 200 })],
      }),
    });

    const dearUrgency = scoreCandidate(candidate({}), dear).urgency;
    const cheapUrgency = scoreCandidate(candidate({}), cheap).urgency;
    expect(dearUrgency).toBeLessThan(cheapUrgency);
    expect(dearUrgency).toBeGreaterThan(cheapUrgency / 2);
  });

  it('charges nothing for cost until a run has been timed', () => {
    const scored = scoreCandidate(
      candidate({}),
      baseInput({
        health: healthFixture({ effectiveness: [stats({ runs: 4, improved: 4 })] }),
      }),
    );
    expect(scored.urgency).toBeCloseTo(0.5, 6);
  });
});

describe('costDivisor', () => {
  it('charges nothing at or under the reference cost', () => {
    expect(costDivisor(undefined, COST)).toBe(1);
    expect(costDivisor(0, COST)).toBe(1);
    expect(costDivisor(1_000, COST)).toBe(1);
  });

  it('rises with cost and stops at the ceiling', () => {
    expect(costDivisor(10_000, COST)).toBeGreaterThan(1);
    expect(costDivisor(100_000, COST)).toBeGreaterThan(costDivisor(10_000, COST));
    expect(costDivisor(1_000_000, COST)).toBeCloseTo(2, 6);
    expect(costDivisor(600_000_000, COST)).toBeCloseTo(2, 6);
  });

  it('follows the configured scale rather than a built-in one', () => {
    const wider: CostScale = { referenceMs: 10_000, decades: 2, maxDivisor: 4 };

    expect(costDivisor(10_000, wider)).toBe(1);
    expect(costDivisor(1_000_000, wider)).toBeCloseTo(4, 6);
    expect(costDivisor(100_000, wider)).toBeCloseTo(2.5, 6);
  });
});

describe('decide', () => {
  it('selects the critical operation ahead of a more urgent routine one', () => {
    const health = healthFixture({
      graph: {
        ...NEUTRAL_GRAPH_HEALTH,
        vectorExpected: POPULATION,
        vectorPresent: 10,
        vectorParity: 0.1,
      },
    });
    const decision = decide(
      baseInput({
        health,
        candidates: [
          candidate({ name: 'routine', relevance: 1 }),
          candidate({ name: 'vector_backfill', answers: 'vector_parity', relevance: 0.4 }),
        ],
      }),
    );
    expect(decision).toMatchObject({ kind: 'selected', name: 'vector_backfill', tier: 1 });
  });

  it('scores an operation routinely on a cycle its own condition does not hold', () => {
    const decision = decide(
      baseInput({
        candidates: [
          candidate({ name: 'routine', relevance: 0.4 }),
          candidate({ name: 'vector_backfill', answers: 'vector_parity', relevance: 0.9 }),
        ],
      }),
    );
    expect(decision).toMatchObject({ kind: 'selected', name: 'vector_backfill', tier: 2 });
  });

  it('names the condition the selected operation answers, not every condition met', () => {
    const health = healthFixture({
      graph: {
        ...NEUTRAL_GRAPH_HEALTH,
        nodes: POPULATION,
        orphanShare: 0.6,
        vectorExpected: POPULATION,
        vectorPresent: 10,
        vectorParity: 0.1,
      },
    });
    const decision = decide(
      baseInput({
        health,
        candidates: [
          candidate({ name: 'orphan_cleanup', answers: 'orphan_share', relevance: 0.6 }),
        ],
      }),
    );
    expect(decision).toMatchObject({ kind: 'selected', tier: 1, reason: 'critical: orphan_share' });
  });

  it('stops preempting once an emergency has run its grace out without moving its metric', () => {
    const graph = {
      ...NEUTRAL_GRAPH_HEALTH,
      nodes: POPULATION,
      orphanShare: 0.6,
    };
    const candidates = [
      candidate({ name: 'orphan_cleanup', answers: 'orphan_share', relevance: 0.6 }),
      candidate({ name: 'routine', relevance: 0.5 }),
    ];

    // Inside the grace, the standing condition still preempts a fully relevant routine one.
    const trying = decide(
      baseInput({
        health: healthFixture({
          graph,
          effectiveness: [
            stats({
              name: 'orphan_cleanup',
              runs: CRITICAL_PREEMPTION_GRACE_RUNS - 1,
              effectiveness: 0,
            }),
          ],
        }),
        candidates,
      }),
    );
    expect(trying).toMatchObject({ kind: 'selected', name: 'orphan_cleanup', tier: 1 });

    // Past it, with nothing to show for the runs, the catalog gets its turn back.
    const spent = decide(
      baseInput({
        health: healthFixture({
          graph,
          effectiveness: [
            stats({
              name: 'orphan_cleanup',
              runs: CRITICAL_PREEMPTION_GRACE_RUNS,
              effectiveness: 0,
            }),
          ],
        }),
        candidates,
      }),
    );
    expect(spent).toMatchObject({ kind: 'selected', name: 'routine', tier: 2 });
  });

  it('keeps preempting while the emergency is still moving its metric', () => {
    const decision = decide(
      baseInput({
        health: healthFixture({
          graph: {
            ...NEUTRAL_GRAPH_HEALTH,
            nodes: POPULATION,
            orphanShare: 0.6,
          },
          effectiveness: [
            stats({ name: 'orphan_cleanup', runs: 40, improved: 40, effectiveness: 1 }),
          ],
        }),
        candidates: [
          candidate({ name: 'orphan_cleanup', answers: 'orphan_share', relevance: 0.6 }),
          candidate({ name: 'routine', relevance: 1 }),
        ],
      }),
    );
    expect(decision).toMatchObject({ kind: 'selected', name: 'orphan_cleanup', tier: 1 });
  });

  it('keeps preempting past the grace when no metric ever scored the emergency', () => {
    const decision = decide(
      baseInput({
        health: healthFixture({
          graph: {
            ...NEUTRAL_GRAPH_HEALTH,
            nodes: POPULATION,
            orphanShare: 0.6,
          },
          effectiveness: [
            stats({
              name: 'orphan_cleanup',
              runs: CRITICAL_PREEMPTION_GRACE_RUNS * 4,
              improved: 0,
              effectiveness: undefined,
            }),
          ],
        }),
        candidates: [
          candidate({ name: 'orphan_cleanup', answers: 'orphan_share', relevance: 0.6 }),
          candidate({ name: 'routine', relevance: 1 }),
        ],
      }),
    );
    expect(decision).toMatchObject({ kind: 'selected', name: 'orphan_cleanup', tier: 1 });
  });

  it('leaves a routine operation under the threshold alone', () => {
    const decision = decide(baseInput({ candidates: [candidate({ relevance: 0.1 })] }));
    expect(decision.kind).toBe('idle');
  });

  it('runs the same operation once it has waited long enough', () => {
    const waited = baseInput({
      health: healthFixture({ effectiveness: [stats({ cyclesSinceSelected: 16 })] }),
      candidates: [candidate({ relevance: 0.1 })],
    });
    expect(decide(waited)).toMatchObject({ kind: 'selected', name: 'routine' });
  });

  it('prefers the operation that has waited longer when urgency ties', () => {
    const health = healthFixture({
      effectiveness: [
        stats({ name: 'fresh', cyclesSinceSelected: 0 }),
        stats({ name: 'patient', cyclesSinceSelected: 0 }),
      ],
    });
    const decision = decide(
      baseInput({
        health,
        candidates: [
          candidate({ name: 'fresh', relevance: 0.5 }),
          candidate({ name: 'patient', relevance: 0.5 }),
        ],
      }),
    );
    // Equal on every term, so the name breaks the tie rather than the registration order.
    expect(decision).toMatchObject({ kind: 'selected', name: 'fresh' });
  });

  it('reaches tier 3 only when it is enabled', () => {
    const candidates = [candidate({ relevance: 0.05 })];
    expect(decide(baseInput({ candidates })).kind).toBe('idle');
    expect(decide(baseInput({ candidates, tier3Enabled: true })).kind).toBe('tier3');
  });
});
