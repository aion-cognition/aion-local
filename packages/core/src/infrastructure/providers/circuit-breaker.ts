import { isAbortError } from '../errors.js';

export type CircuitBreakerOptions = {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
};

export class CircuitOpenError extends Error {
  constructor(cooldownRemainingMs: number) {
    super(`circuit open; retry in ${cooldownRemainingMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Opens after 5 consecutive failures, fast-fails for a 60s cooldown, then allows one trial
 * call. A failed trial re-opens for another cooldown rather than handing back a fresh budget,
 * so a provider that is still down costs one call per cooldown instead of `failureThreshold`
 * of them. Generic over the wrapped call so one policy covers any async provider call.
 *
 * An abort does not count. A caller's deadline and a shutdown are the caller's own doing and
 * say nothing about the provider, so counting them would open it against the next healthy call.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private halfOpen = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.openedAt !== null) {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new CircuitOpenError(this.cooldownMs - elapsed);
      }
      // The cooldown is spent, so this call is the trial. The counter stays where it is until
      // the trial answers: clearing it here is what handed a still-dead provider a new budget.
      this.openedAt = null;
      this.halfOpen = true;
    }

    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      this.halfOpen = false;
      return result;
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      if (this.halfOpen) {
        this.openedAt = this.now();
        throw err;
      }
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openedAt = this.now();
      }
      throw err;
    }
  }
}
