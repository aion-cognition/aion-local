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
 * PRD §10 / whitepaper §12.4: opens after 5 consecutive failures, fast-fails for a
 * 60s cooldown, then allows one trial call. Generic over the wrapped call so P2 can
 * wrap both `embed` and `generate` with the same instance policy without a second
 * implementation.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

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
      this.openedAt = null;
      this.consecutiveFailures = 0;
    }

    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openedAt = this.now();
      }
      throw err;
    }
  }
}
