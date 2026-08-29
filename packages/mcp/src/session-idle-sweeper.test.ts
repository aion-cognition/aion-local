import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLogger, type Logger } from '@aion/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AionMcpService } from './service.js';
import {
  MIN_SESSION_IDLE_SWEEP_INTERVAL_MS,
  SessionIdleSweeper,
  sessionIdleSweepIntervalMs,
} from './session-idle-sweeper.js';
import type { ToolBackend } from './tools.js';

/**
 * The scheduler, not the closing logic: `service.test.ts`'s `closeIdleSessions` describe
 * block covers which sessions qualify. What matters here is that something on a clock
 * reaches it (EX-32: without one, a client's close() that never sends DELETE leaves its
 * session behind indefinitely, not just until the next tick).
 */

const IDLE_MS = 30 * 60 * 1000;

const backend: ToolBackend = {
  recall: () => Promise.reject(new Error('not used by this suite')),
  reflection: () => Promise.reject(new Error('not used by this suite')),
};

let dir: string;
let logger: Logger;
let service: AionMcpService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-session-idle-sweeper-'));
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  service = new AionMcpService({ backend, logger, host: '127.0.0.1', port: 0 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sessionIdleSweepIntervalMs', () => {
  it('sweeps twice per idle window, never faster than the floor', () => {
    expect(sessionIdleSweepIntervalMs(IDLE_MS)).toBe(IDLE_MS / 2);
    expect(sessionIdleSweepIntervalMs(1_000)).toBe(MIN_SESSION_IDLE_SWEEP_INTERVAL_MS);
  });
});

describe('SessionIdleSweeper', () => {
  it('reaches the idle check on its own schedule', () => {
    const sweeper = new SessionIdleSweeper(service, { idleMs: IDLE_MS });
    const swept = vi.spyOn(service, 'closeIdleSessions');

    vi.useFakeTimers();
    try {
      sweeper.start();
      expect(swept).not.toHaveBeenCalled();

      vi.advanceTimersByTime(sweeper.intervalMs + 1);
      expect(swept).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(sweeper.intervalMs);
      expect(swept).toHaveBeenCalledTimes(2);
    } finally {
      sweeper.stop();
      vi.useRealTimers();
    }
  });

  it('stops sweeping once stopped', () => {
    const sweeper = new SessionIdleSweeper(service, { idleMs: IDLE_MS });
    const swept = vi.spyOn(service, 'closeIdleSessions');

    vi.useFakeTimers();
    try {
      sweeper.start();
      sweeper.stop();
      vi.advanceTimersByTime(sweeper.intervalMs * 3);
    } finally {
      vi.useRealTimers();
    }

    expect(swept).not.toHaveBeenCalled();
  });

  it('starting twice does not double the timer', () => {
    const sweeper = new SessionIdleSweeper(service, { idleMs: IDLE_MS });
    const swept = vi.spyOn(service, 'closeIdleSessions');

    vi.useFakeTimers();
    try {
      sweeper.start();
      sweeper.start();
      vi.advanceTimersByTime(sweeper.intervalMs + 1);
      expect(swept).toHaveBeenCalledTimes(1);
    } finally {
      sweeper.stop();
      vi.useRealTimers();
    }
  });
});
