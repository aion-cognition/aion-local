import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DRAIN_INTERVAL_MS,
  ReinforcementCadence,
  ReinforcementDrain,
  type HebbianFlushReport,
} from './drain.js';
import { aggregateWindow, type QueuedSignal } from '../domain/reinforcement.js';

/**
 * The dedicated drain: one owner, its own cadence, and what splitting a window costs.
 *
 * The learning consequence is asserted here rather than described, because it is the part of
 * this change that is not about latency: a faster cadence folds the same signals into more
 * windows, and a pair whose evidence crosses two windows spends two bounded steps where it
 * used to spend one.
 */

function report(signalsClaimed: number): HebbianFlushReport {
  return {
    signalsClaimed,
    pairsApplied: signalsClaimed === 0 ? 0 : 1,
    edgesUpdated: signalsClaimed === 0 ? 0 : 1,
    signalsDeleted: signalsClaimed,
  };
}

function drainOf(batches: readonly number[], ceiling = 2_000): ReinforcementDrain {
  let index = 0;
  return new ReinforcementDrain({
    ceiling,
    drainOneBatch: () => Promise.resolve(report(batches[index++] ?? 0)),
  });
}

describe('ReinforcementDrain', () => {
  it('drains batches until the queue reports empty', async () => {
    const drain = drainOf([100, 100, 0]);

    const outcome = await drain.drainOnce();

    expect(outcome).toEqual(
      expect.objectContaining({ signalsClaimed: 200, batches: 3, ceilingHit: false }),
    );
  });

  it('stops at the run ceiling with signals still queued', async () => {
    const drain = drainOf([100, 100, 100], 150);

    const outcome = await drain.drainOnce();

    expect(outcome.ceilingHit).toBe(true);
    expect(outcome.signalsClaimed).toBe(200);
  });

  it('lets one caller at a time consume, and tells the second it consumed nothing', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const drain = new ReinforcementDrain({
      ceiling: 2_000,
      drainOneBatch: async () => {
        calls += 1;
        await held;
        return report(0);
      },
    });

    const first = drain.drainOnce();
    const second = drain.drainOnce();
    release?.();

    const [ran, deferred] = await Promise.all([first, second]);
    expect(ran.deferred).toBe(false);
    expect(deferred).toEqual(expect.objectContaining({ deferred: true, signalsClaimed: 0 }));
    expect(calls).toBe(1);
  });

  it('stops draining when the caller aborts', async () => {
    const controller = new AbortController();
    const drain = new ReinforcementDrain({
      ceiling: 2_000,
      drainOneBatch: () => {
        controller.abort();
        return Promise.resolve(report(100));
      },
    });

    const outcome = await drain.drainOnce(controller.signal);

    expect(outcome.aborted).toBe(true);
    expect(outcome.batches).toBe(1);
  });
});

describe('ReinforcementCadence', () => {
  it('runs on the five-second cadence the paper names, unless a deployment says otherwise', () => {
    expect(DEFAULT_DRAIN_INTERVAL_MS).toBe(5_000);
  });

  it('drains on its own clock and rearms from the end of each drain', async () => {
    const drains: number[] = [];
    const drain = new ReinforcementDrain({
      ceiling: 2_000,
      drainOneBatch: () => {
        drains.push(Date.now());
        return Promise.resolve(report(0));
      },
    });
    const cadence = new ReinforcementCadence(drain, { intervalMs: 5 });

    cadence.start();
    await waitFor(() => drains.length >= 3);
    await cadence.stop();
    const seen = drains.length;
    await pause(25);

    expect(seen).toBeGreaterThanOrEqual(3);
    expect(drains.length).toBe(seen);
  });

  it('waits out the drain in flight before it reports stopped', async () => {
    let finished = false;
    const drain = new ReinforcementDrain({
      ceiling: 2_000,
      drainOneBatch: async () => {
        await pause(20);
        finished = true;
        return report(0);
      },
    });
    const cadence = new ReinforcementCadence(drain, { intervalMs: 1 });

    cadence.start();
    await pause(5);
    await cadence.stop();

    expect(finished).toBe(true);
  });

  it('stays stopped once stopped', async () => {
    const drain = drainOf([0, 0, 0]);
    const cadence = new ReinforcementCadence(drain, { intervalMs: 1 });

    cadence.start();
    await cadence.stop();
    cadence.start();

    expect(cadence.running).toBe(false);
  });
});

describe('the learning cost of a faster cadence', () => {
  const burst = (ts: string, pairs: number): readonly QueuedSignal[] =>
    Array.from({ length: pairs }, (_, index) => ({
      sourceId: 'a',
      targetId: `b${String(index)}`,
      trigger: 'recall_pack_exposure',
      ts,
    }));

  it('applies more steps to one pair when its evidence is split across more windows', () => {
    const rate = 0.1;
    const one = burst('2026-09-13T12:00:00.000Z', 1);
    const two = burst('2026-09-13T12:00:01.000Z', 1);

    const together = aggregateWindow([...one, ...two], rate);
    const apart = [aggregateWindow(one, rate), aggregateWindow(two, rate)];

    // One window folds both bursts into a single bounded step for the pair; two windows apply
    // two. The asymptote keeps the difference small, and it is a real difference: a substrate on
    // the faster cadence learns a repeated co-activation slightly faster than one on the slower
    // cadence saw the same stream.
    expect(together).toHaveLength(1);
    expect(apart.every((window) => window.length === 1)).toBe(true);

    const afterOneStep = step(0, together[0]!.learningRate);
    const afterTwoSteps = apart.reduce(
      (weight, window) => step(weight, window[0]!.learningRate),
      0,
    );
    expect(afterTwoSteps).toBeGreaterThan(afterOneStep);
    expect(afterTwoSteps).toBeLessThan(1);
  });
});

function step(weight: number, rate: number): number {
  return weight + rate * (1 - weight);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await pause(5);
  }
  throw new Error('condition never held');
}
