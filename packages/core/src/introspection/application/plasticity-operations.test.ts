import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  DECAY_STALE_HOURS,
  DECAY_STANDING_RELEVANCE,
  DEFAULT_HEBBIAN_DECAY_SCAN_FRACTION,
  DEFAULT_HEBBIAN_FLUSH_CEILING,
  MEMORY_DECAY_OPERATION,
  REINFORCEMENT_FLUSH_OPERATION,
  decayScanQuota,
  drainReinforcementQueue,
  memoryDecayOperation,
  memoryDecayRelevance,
  reinforcementFlushRelevance,
} from './plasticity-operations.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { HebbianFlushReport } from '../../plasticity/application/flush.js';
import { decide, DEPRIORITIZED_WEIGHT, type DecisionInput } from '../domain/decide.js';
import { NEUTRAL_GRAPH_HEALTH, type HealthSnapshot } from '../domain/health.js';
import type { OperationContext } from '../domain/operation.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

const EMPTY_BATCH: HebbianFlushReport = {
  signalsClaimed: 0,
  pairsApplied: 0,
  edgesUpdated: 0,
  signalsDeleted: 0,
};

function batchOf(signalsClaimed: number): HebbianFlushReport {
  return {
    signalsClaimed,
    pairsApplied: signalsClaimed,
    edgesUpdated: signalsClaimed,
    signalsDeleted: signalsClaimed,
  };
}

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

describe('flush and decay run-sizing knobs match the shipped configuration', () => {
  it('carries the pinned flush ceiling and decay scan fraction', () => {
    expect(DEFAULT_HEBBIAN_FLUSH_CEILING).toBe(DEFAULTS.hebbian.flushCeiling);
    expect(DEFAULT_HEBBIAN_DECAY_SCAN_FRACTION).toBe(DEFAULTS.hebbian.decayScanFraction);
  });
});

describe('reinforcementFlushRelevance', () => {
  it('is zero on an empty queue and rises linearly with depth', () => {
    expect(reinforcementFlushRelevance(healthFixture())).toBe(0);
    const half = healthFixture({
      plasticity: {
        reinforcementQueueDepth: DEFAULT_HEBBIAN_FLUSH_CEILING / 2,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: undefined,
      },
    });
    expect(reinforcementFlushRelevance(half)).toBeCloseTo(0.5, 6);
  });

  it('caps at one once the backlog reaches a full ceiling, rather than growing without bound', () => {
    const swamped = healthFixture({
      plasticity: {
        reinforcementQueueDepth: DEFAULT_HEBBIAN_FLUSH_CEILING * 11,
        reinforcementLastRunAt: undefined,
        decayLastRunAt: undefined,
      },
    });
    expect(reinforcementFlushRelevance(swamped)).toBe(1);
  });

  it('clears the urgency threshold at a depth well under one ceiling even at the deprioritized weight', () => {
    // The exact crossing point the docblock claims: two fifths of a ceiling, scored at half
    // weight, lands exactly on the default threshold.
    const depth = DEFAULT_HEBBIAN_FLUSH_CEILING * 0.4;
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
    // A backlog large enough to select flush outright, with nothing else in the graph yet:
    // three fifths of one ceiling clears the default urgency threshold at full weight with
    // no starvation boost needed.
    const health = healthFixture({
      plasticity: {
        reinforcementQueueDepth: DEFAULT_HEBBIAN_FLUSH_CEILING * 0.6,
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
    // A small personal graph's real but unspectacular backlog: a fifth of one ceiling, an
    // operation still under its effectiveness floor from an earlier bad run, no starvation
    // boost yet. Relevance alone does not clear the threshold at that depth and that weight;
    // the wait does, at the configured span, which is the backstop this depends on rather
    // than a slow crawl toward it.
    const depth = DEFAULT_HEBBIAN_FLUSH_CEILING * 0.2;
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
            meanDurationMs: undefined,
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
          meanDurationMs: undefined,
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

describe('decayScanQuota', () => {
  it('scans nothing on a graph with no decayable edges', () => {
    expect(decayScanQuota(0, DEFAULT_HEBBIAN_DECAY_SCAN_FRACTION)).toBe(0);
  });

  it('rounds up to the configured fraction of decayable edges', () => {
    expect(decayScanQuota(8_402, 0.15)).toBe(Math.ceil(8_402 * 0.15));
    expect(decayScanQuota(1_000, 0.5)).toBe(500);
  });

  it('never rounds a thin fraction down to zero on a graph that does have edges to decay', () => {
    expect(decayScanQuota(3, 0.01)).toBe(1);
  });

  it('scans the whole graph at a fraction of one', () => {
    expect(decayScanQuota(250, 1)).toBe(250);
  });
});

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

describe('memoryDecayOperation, run directly rather than through the engine', () => {
  it('reports a noop without touching the graph when the snapshot has nothing decayable', async () => {
    const ctx: OperationContext = {
      driver: undefined as unknown as Driver,
      db: undefined as unknown as SqliteHandle,
      config: DEFAULTS,
      logger: silentLogger(),
      provider: refusingProvider,
      health: healthFixture({ graph: { ...NEUTRAL_GRAPH_HEALTH, decayableEdges: 0 } }),
      now: new Date('2026-08-31T00:00:00.000Z'),
      signal: new AbortController().signal,
    };

    // Relevance already keeps the engine from ever selecting this operation on such a
    // snapshot; this pins that running it anyway (a test, a tier-3 recommendation) is still
    // safe, since a zero-edge quota would otherwise reach the graph write as a batch size the
    // write itself rejects.
    const outcome = await memoryDecayOperation().run(ctx);
    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'no decayable edges reported by the snapshot',
    });
  });
});

describe('drainReinforcementQueue', () => {
  it('calls once and stops on an empty queue', async () => {
    let calls = 0;
    const report = await drainReinforcementQueue(
      async () => {
        calls += 1;
        return EMPTY_BATCH;
      },
      DEFAULT_HEBBIAN_FLUSH_CEILING,
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(report).toMatchObject({
      signalsClaimed: 0,
      batches: 1,
      ceilingHit: false,
      aborted: false,
    });
  });

  it('keeps draining full batches until the queue empties, below the ceiling', async () => {
    const queue = [100, 100, 40, 0];
    let index = 0;
    const report = await drainReinforcementQueue(
      async () => batchOf(queue[index++] ?? 0),
      1_000,
      new AbortController().signal,
    );
    expect(index).toBe(4);
    expect(report).toMatchObject({
      signalsClaimed: 240,
      batches: 4,
      ceilingHit: false,
      aborted: false,
    });
  });

  it('stops at the ceiling with signals still queued, rather than draining forever', async () => {
    let calls = 0;
    const report = await drainReinforcementQueue(
      async () => {
        calls += 1;
        return batchOf(100);
      },
      250,
      new AbortController().signal,
    );
    // 100, 200, 300: the third call is what crosses 250, and the loop takes the whole burst
    // rather than splitting it, the same rounding one batch already does.
    expect(calls).toBe(3);
    expect(report).toMatchObject({
      signalsClaimed: 300,
      batches: 3,
      ceilingHit: true,
      aborted: false,
    });
  });

  it('stops mid-drain once the signal aborts, keeping what it already claimed', async () => {
    const controller = new AbortController();
    let calls = 0;
    const report = await drainReinforcementQueue(
      async () => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
        }
        return batchOf(100);
      },
      DEFAULT_HEBBIAN_FLUSH_CEILING,
      controller.signal,
    );
    expect(calls).toBe(2);
    expect(report).toMatchObject({
      signalsClaimed: 200,
      batches: 2,
      ceilingHit: false,
      aborted: true,
    });
  });

  it('never calls the batch function at all when the signal starts already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const report = await drainReinforcementQueue(
      async () => {
        calls += 1;
        return batchOf(100);
      },
      DEFAULT_HEBBIAN_FLUSH_CEILING,
      controller.signal,
    );
    expect(calls).toBe(0);
    expect(report).toMatchObject({ signalsClaimed: 0, batches: 0, aborted: true });
  });
});
