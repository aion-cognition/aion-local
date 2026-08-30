import { describe, expect, it } from 'vitest';

import {
  DECAY_STALE_HOURS,
  DECAY_STANDING_RELEVANCE,
  MEMORY_DECAY_OPERATION,
  REINFORCEMENT_FLUSH_OPERATION,
  memoryDecayRelevance,
  reinforcementFlushRelevance,
} from './plasticity-operations.js';
import { DEFAULT_HEBBIAN_BATCH_SIZE } from '../../plasticity/application/flush.js';
import { decide, DEPRIORITIZED_WEIGHT, type DecisionInput } from '../domain/decide.js';
import { NEUTRAL_GRAPH_HEALTH, type HealthSnapshot } from '../domain/health.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

/**
 * Both operations' relevance functions, and the decisions they drive, exercised without a
 * live substrate: `decide` is pure, so a fixture snapshot reaches the same answer a real tick
 * would without a clock or a database.
 */

function baseInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    health: healthFixture(),
    candidates: [],
    starvationCycles: 8,
    urgencyThreshold: 0.2,
    effectivenessFloor: 0.5,
    tier3Enabled: false,
    ...overrides,
  };
}

describe('reinforcementFlushRelevance', () => {
  it('is zero on an empty queue and rises linearly with depth', () => {
    expect(reinforcementFlushRelevance(healthFixture())).toBe(0);
    const half = healthFixture({
      plasticity: {
        reinforcementQueueDepth: DEFAULT_HEBBIAN_BATCH_SIZE / 2,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: undefined,
      },
    });
    expect(reinforcementFlushRelevance(half)).toBeCloseTo(0.5, 6);
  });

  it('caps at one once the backlog reaches a full batch, rather than growing without bound', () => {
    const swamped = healthFixture({
      plasticity: {
        reinforcementQueueDepth: DEFAULT_HEBBIAN_BATCH_SIZE * 11,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: undefined,
      },
    });
    expect(reinforcementFlushRelevance(swamped)).toBe(1);
  });

  it('clears the urgency threshold at a depth well under one batch even at the deprioritized weight', () => {
    // The exact crossing point the docblock claims: two fifths of a batch, scored at half
    // weight, lands exactly on the default threshold.
    const depth = DEFAULT_HEBBIAN_BATCH_SIZE * 0.4;
    const relevance = reinforcementFlushRelevance(
      healthFixture({
        plasticity: {
          reinforcementQueueDepth: depth,
          reinforcementLastRunAt: undefined,
          decayLastRunAt: undefined,
        },
      }),
    );
    expect(relevance * DEPRIORITIZED_WEIGHT).toBeCloseTo(0.2, 6);
  });
});

describe('memoryDecayRelevance', () => {
  const withEdges = { ...NEUTRAL_GRAPH_HEALTH, decayableEdges: 3 };

  it('is zero on a graph with nothing decayable, however long the wait', () => {
    const health = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, decayableEdges: 0 },
      plasticity: {
        reinforcementQueueDepth: 0,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: undefined,
      },
    });
    expect(memoryDecayRelevance(health)).toBe(0);
  });

  it('holds the standing floor right after a sweep, on a graph that still has edges to decay', () => {
    const observedAt = '2026-08-29T12:00:00.000Z';
    const health: HealthSnapshot = {
      ...healthFixture({ graph: withEdges }),
      observedAt,
      plasticity: {
        reinforcementQueueDepth: 0,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: observedAt,
      },
    };
    expect(memoryDecayRelevance(health)).toBe(DECAY_STANDING_RELEVANCE);
  });

  it('ramps to full relevance by the staleness floor and holds there past it', () => {
    const observedAt = '2026-08-29T16:00:00.000Z';
    const stale = (hoursAgo: number): HealthSnapshot => ({
      ...healthFixture({ graph: withEdges }),
      observedAt,
      plasticity: {
        reinforcementQueueDepth: 0,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: new Date(Date.parse(observedAt) - hoursAgo * 3_600_000).toISOString(),
      },
    });
    expect(memoryDecayRelevance(stale(DECAY_STALE_HOURS / 2))).toBeCloseTo(0.5, 6);
    expect(memoryDecayRelevance(stale(DECAY_STALE_HOURS))).toBe(1);
    expect(memoryDecayRelevance(stale(DECAY_STALE_HOURS * 10))).toBe(1);
  });

  it('reads never-run as maximally stale rather than waiting on a first sweep to measure from', () => {
    const health = healthFixture({
      graph: withEdges,
      plasticity: {
        reinforcementQueueDepth: 0,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: undefined,
      },
    });
    expect(memoryDecayRelevance(health)).toBe(1);
  });
});

describe('decide, on fresh-graph fixtures (no live tick, no waiting)', () => {
  it('selects reinforcement_flush on the very first cycle against the round-2 backlog', () => {
    // A backlog large enough to select flush outright, with nothing else in the graph yet.
    const health = healthFixture({
      plasticity: {
        reinforcementQueueDepth: 1_099,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: undefined,
      },
    });
    const decision = decide(
      baseInput({
        health,
        candidates: [
          { name: REINFORCEMENT_FLUSH_OPERATION, relevance: reinforcementFlushRelevance(health) },
        ],
      }),
    );
    expect(decision).toMatchObject({
      kind: 'selected',
      name: REINFORCEMENT_FLUSH_OPERATION,
      tier: 2,
    });
  });

  it('still selects flush inside the starvation window on a modest backlog, not just when it floods', () => {
    // A small personal graph's real but unspectacular backlog: a fifth of one batch, an
    // operation still under its effectiveness floor from an earlier bad run, no starvation
    // boost yet. Relevance alone does not clear the threshold at that depth and that weight;
    // the wait does, at the configured span, which is the backstop this depends on rather
    // than a slow crawl toward it.
    const depth = DEFAULT_HEBBIAN_BATCH_SIZE * 0.2;
    let decision;
    for (let cyclesWaited = 0; cyclesWaited <= 8; cyclesWaited += 1) {
      const health = healthFixture({
        plasticity: {
          reinforcementQueueDepth: depth,
          reinforcementLastRunAt: undefined,
          decayLastRunAt: undefined,
        },
        effectiveness: [
          {
            name: REINFORCEMENT_FLUSH_OPERATION,
            runs: 4,
            improved: 1,
            failed: 3,
            effectiveness: 0.25,
            cyclesSinceSelected: cyclesWaited,
            lastRunAt: '2026-08-29T00:00:00.000Z',
          },
        ],
      });
      decision = decide(
        baseInput({
          health,
          candidates: [
            {
              name: REINFORCEMENT_FLUSH_OPERATION,
              relevance: reinforcementFlushRelevance(health),
            },
          ],
        }),
      );
      if (decision.kind === 'selected') {
        break;
      }
    }
    expect(decision).toMatchObject({ kind: 'selected', name: REINFORCEMENT_FLUSH_OPERATION });
  });

  it('selects memory_decay on the first cycle once the graph has an edge to decay and never has', () => {
    const health = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, decayableEdges: 1 },
      plasticity: {
        reinforcementQueueDepth: 0,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: undefined,
      },
    });
    const decision = decide(
      baseInput({
        health,
        candidates: [{ name: MEMORY_DECAY_OPERATION, relevance: memoryDecayRelevance(health) }],
      }),
    );
    expect(decision).toMatchObject({ kind: 'selected', name: MEMORY_DECAY_OPERATION, tier: 2 });
  });

  it('never selects memory_decay on a graph with nothing decayable, however long it waits', () => {
    const health = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, decayableEdges: 0 },
      effectiveness: [
        {
          name: MEMORY_DECAY_OPERATION,
          runs: 0,
          improved: 0,
          failed: 0,
          effectiveness: 1,
          cyclesSinceSelected: 10_000,
          lastRunAt: undefined,
        },
      ],
    });
    const decision = decide(
      baseInput({
        health,
        candidates: [{ name: MEMORY_DECAY_OPERATION, relevance: memoryDecayRelevance(health) }],
      }),
    );
    expect(decision.kind).toBe('idle');
  });
});
