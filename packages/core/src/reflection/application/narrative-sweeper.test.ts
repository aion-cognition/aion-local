import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { NarrativeFakeGraph } from '../test-support/narrative-graph.fixture.js';
import {
  IdleNarrativeSweeper,
  MIN_SWEEP_INTERVAL_MS,
  sweepIntervalMs,
} from './narrative-sweeper.js';
import type { NarrativeDeps } from './narratives.js';

/**
 * The scheduler, not the sweep. What is asserted here is that something on a clock reaches
 * `sweepIdleSessions` at all: the idle half of the pinned narrative trigger was fully built
 * and fully tested with no production caller, so a client that disconnects without a DELETE
 * got no narrative.
 */

const IDLE_MS = 30 * 60 * 1000;

let dir: string;
let logger: Logger;
let graph: NarrativeFakeGraph;

const provider: Provider = {
  embed: async (texts) => texts.map(() => [1, 0, 0]),
  generate: async () => ({ narrative: 'the session, compressed', summary: 'a summary' }),
};

function deps(): NarrativeDeps {
  return { driver: graph.driver, provider, logger };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-narrative-sweeper-'));
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  graph = new NarrativeFakeGraph();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sweepIntervalMs', () => {
  it('sweeps twice per idle window, never faster than the floor', () => {
    expect(sweepIntervalMs(IDLE_MS)).toBe(IDLE_MS / 2);
    expect(sweepIntervalMs(1_000)).toBe(MIN_SWEEP_INTERVAL_MS);
  });
});

describe('IdleNarrativeSweeper', () => {
  it('reaches the idle sweep on its own schedule', async () => {
    const sweeper = new IdleNarrativeSweeper(deps(), { idleMs: IDLE_MS });
    const swept = vi.spyOn(sweeper, 'sweepOnce');

    vi.useFakeTimers();
    try {
      sweeper.start();
      expect(swept).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(sweeper.intervalMs + 1);
      expect(swept).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(sweeper.intervalMs);
      expect(swept).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await sweeper.stop();
    }
  });

  it('stops sweeping once stopped', async () => {
    const sweeper = new IdleNarrativeSweeper(deps(), { idleMs: IDLE_MS });
    const swept = vi.spyOn(sweeper, 'sweepOnce');

    vi.useFakeTimers();
    try {
      sweeper.start();
      await sweeper.stop();
      await vi.advanceTimersByTimeAsync(sweeper.intervalMs * 3);
    } finally {
      vi.useRealTimers();
    }

    expect(swept).not.toHaveBeenCalled();
  });

  it('swallows a failing sweep so the next tick still runs', async () => {
    const failing: NarrativeDeps = {
      driver: graph.driver,
      provider,
      logger,
    };
    vi.spyOn(graph.driver, 'executeQuery').mockRejectedValue(new Error('neo4j is down'));
    const sweeper = new IdleNarrativeSweeper(failing, { idleMs: IDLE_MS });

    await expect(sweeper.sweepOnce()).resolves.toEqual([]);
  });
});
