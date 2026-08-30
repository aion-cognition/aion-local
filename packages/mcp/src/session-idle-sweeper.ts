import { halfWindowIntervalMs, MIN_SWEEP_INTERVAL_MS, SweepTimer } from '@aion/core';

import type { AionMcpService } from './service.js';

/**
 * The session-close trigger that actually fires, on a clock. A standard MCP client's
 * `close()` aborts its own transport without issuing the DELETE the hook depends on, so this
 * is the primary path and the hook is the fast case when a client does send one.
 * `AionMcpService.closeIdleSessions` decides which sessions
 * qualify; this only keeps a tick reaching it, the same split `IdleNarrativeSweeper` (core)
 * uses for the idle narrative rule. Sweeping at half the idle window bounds how stale a
 * session can get past its deadline before something notices; the floor keeps a small
 * configured window from turning the sweep into a spin.
 */

export const MIN_SESSION_IDLE_SWEEP_INTERVAL_MS = MIN_SWEEP_INTERVAL_MS;

export function sessionIdleSweepIntervalMs(idleMs: number): number {
  return halfWindowIntervalMs(idleMs);
}

export type SessionIdleSweeperOptions = {
  readonly idleMs: number;
};

export class SessionIdleSweeper {
  readonly #service: AionMcpService;
  readonly #idleMs: number;
  readonly #timer: SweepTimer;

  constructor(service: AionMcpService, options: SessionIdleSweeperOptions) {
    this.#service = service;
    this.#idleMs = options.idleMs;
    this.#timer = new SweepTimer(sessionIdleSweepIntervalMs(options.idleMs), () => {
      this.sweepOnce();
    });
  }

  get intervalMs(): number {
    return this.#timer.intervalMs;
  }

  start(): void {
    this.#timer.start();
  }

  stop(): void {
    this.#timer.stop();
  }

  /**
   * One tick's work, exposed so a test can drive it directly instead of a real interval.
   * `now` is a test seam for the same reason `closeIdleSessions` takes one.
   */
  sweepOnce(now?: Date): readonly string[] {
    return this.#service.closeIdleSessions(this.#idleMs, now?.getTime());
  }
}
