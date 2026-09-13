import { describe, expect, it } from 'vitest';

import { drainReinforcementQueue, type HebbianFlushReport } from './drain.js';
import { DEFAULT_HEBBIAN_FLUSH_CEILING } from '../../introspection/application/plasticity-operations.js';

/**
 * The bounded drain loop's own stopping conditions, against canned batch reports: no queue, no
 * database, no graph. It moved here with the loop when ordinary draining got one owner.
 */

const EMPTY_BATCH: HebbianFlushReport = {
  signalsClaimed: 0,
  pairsApplied: 0,
  edgesUpdated: 0,
  signalsDeleted: 0,
};

function batchOf(signals: number): HebbianFlushReport {
  return {
    signalsClaimed: signals,
    pairsApplied: Math.ceil(signals / 2),
    edgesUpdated: Math.ceil(signals / 3),
    signalsDeleted: signals,
  };
}

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
