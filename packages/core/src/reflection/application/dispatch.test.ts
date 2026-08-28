import { describe, expect, it, vi } from 'vitest';
import { ReflectionDispatch, type ReflectionJobSignal } from './dispatch.js';

const SIGNAL: ReflectionJobSignal = {
  jobId: 'job-1',
  jobType: 'integrate',
  episodeId: 'episode-1',
  sessionId: 'session-1',
  enqueuedAt: new Date('2026-08-27T12:00:00.000Z'),
};

describe('ReflectionDispatch', () => {
  it('delivers a signal to every subscriber', () => {
    const dispatch = new ReflectionDispatch();
    const first: ReflectionJobSignal[] = [];
    const second: ReflectionJobSignal[] = [];

    dispatch.subscribe((signal) => {
      first.push(signal);
    });
    dispatch.subscribe((signal) => {
      second.push(signal);
    });
    dispatch.signal(SIGNAL);

    expect(dispatch.listenerCount).toBe(2);
    expect(first).toEqual([SIGNAL]);
    expect(second).toEqual([SIGNAL]);
  });

  it('stops delivering once unsubscribed, and unsubscribing twice is a no-op', () => {
    const dispatch = new ReflectionDispatch();
    const received: ReflectionJobSignal[] = [];
    const unsubscribe = dispatch.subscribe((signal) => {
      received.push(signal);
    });

    unsubscribe();
    unsubscribe();
    dispatch.signal(SIGNAL);

    expect(dispatch.listenerCount).toBe(0);
    expect(received).toEqual([]);
  });

  it('routes a throwing listener to the error handler and still runs the rest', () => {
    const onListenerError = vi.fn();
    const dispatch = new ReflectionDispatch({ onListenerError });
    const received: ReflectionJobSignal[] = [];

    dispatch.subscribe(() => {
      throw new Error('dispatcher exploded');
    });
    dispatch.subscribe((signal) => {
      received.push(signal);
    });
    dispatch.signal(SIGNAL);

    expect(received).toEqual([SIGNAL]);
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(onListenerError.mock.calls[0]?.[1]).toEqual(SIGNAL);
  });

  it('routes a rejected async listener to the error handler without an unhandled rejection', async () => {
    const onListenerError = vi.fn();
    const dispatch = new ReflectionDispatch({ onListenerError });

    dispatch.subscribe(async () => {
      await Promise.reject(new Error('dispatcher exploded later'));
    });
    dispatch.signal(SIGNAL);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  it('swallows a listener failure when no error handler is installed', () => {
    const dispatch = new ReflectionDispatch();
    dispatch.subscribe(() => {
      throw new Error('dispatcher exploded');
    });

    expect(() => {
      dispatch.signal(SIGNAL);
    }).not.toThrow();
  });
});
