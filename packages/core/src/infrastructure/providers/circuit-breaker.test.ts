import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('passes through successful calls and resets the failure count', async () => {
    const breaker = new CircuitBreaker();
    await expect(breaker.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    await expect(breaker.run(() => Promise.resolve('ok again'))).resolves.toBe('ok again');
  });

  it('propagates the wrapped error until the failure threshold is reached', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    const failing = () => Promise.reject(new Error('boom'));

    await expect(breaker.run(failing)).rejects.toThrow('boom');
    await expect(breaker.run(failing)).rejects.toThrow('boom');
  });

  it('opens after the failure threshold and fast-fails without calling the function', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    const fn = vi.fn(() => Promise.reject(new Error('boom')));

    await expect(breaker.run(fn)).rejects.toThrow('boom');
    await expect(breaker.run(fn)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(2);

    await expect(breaker.run(fn)).rejects.toThrow(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('allows a trial call once the cooldown elapses, closing again on success', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
    const fn = vi.fn<() => Promise<string>>(() => Promise.reject(new Error('boom')));

    await expect(breaker.run(fn)).rejects.toThrow('boom');
    await expect(breaker.run(fn)).rejects.toThrow(CircuitOpenError);

    now = 1000;
    fn.mockImplementationOnce(() => Promise.resolve('recovered'));
    await expect(breaker.run(fn)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);

    await expect(breaker.run(fn)).rejects.toThrow('boom');
  });
});
