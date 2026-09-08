import { afterEach, expect, it, vi } from 'vitest';

import { PublicationRecoveryLoop } from './recovery.js';

afterEach(() => {
  vi.useRealTimers();
});

it('recovers on startup without fresh work and backs off without overlapping attempts', async () => {
  vi.useFakeTimers();
  let pending = true;
  let concurrent = 0;
  let peak = 0;
  const recover = vi.fn(async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    try {
      if (recover.mock.calls.length < 3) {
        throw new Error('temporarily unavailable');
      }
      pending = false;
      return undefined;
    } finally {
      concurrent -= 1;
    }
  });
  const loop = new PublicationRecoveryLoop(
    { hasPending: () => pending, recover },
    { warn: vi.fn() },
    { retryBaseMs: 10, retryCapMs: 40 },
  );
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(recover).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10);
  expect(recover).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(19);
  expect(recover).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(recover).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(100);
  expect(recover).toHaveBeenCalledTimes(3);
  expect(peak).toBe(1);
  await loop.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for the active recovery before shutdown and schedules no later attempt', async () => {
  vi.useFakeTimers();
  let release: (() => void) | undefined;
  const recovering = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recover = vi.fn(async () => {
    await recovering;
    return undefined;
  });
  const loop = new PublicationRecoveryLoop(
    { hasPending: () => true, recover },
    { warn: vi.fn() },
    { retryBaseMs: 10, retryCapMs: 40 },
  );
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  let stopped = false;
  const stop = loop.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release?.();
  await stop;
  expect(stopped).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
