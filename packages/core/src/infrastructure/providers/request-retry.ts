import { abortRequested } from './deadline-signal.js';

/**
 * The retry rules both remote routes share. A 429, an overload or a 5xx is a normal event on a
 * shared key rather than a failure, so a route absorbs a few of them before the caller's own
 * backoff (the reflection worker's, which stretches to minutes) gets a turn.
 */

/** Three tries at a throttled or overloaded response, then the real error reaches the caller. */
export const MAX_ATTEMPTS = 3;

export const MAX_BACKOFF_MS = 30_000;

export function throttled(status: number): boolean {
  return status === 429 || status >= 500;
}

/** The server's own `retry-after` in seconds where it sent one, else a growing default. */
export function retryWaitMs(response: Response, attempts: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  const waitMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempts * 2000;
  return Math.min(waitMs, MAX_BACKOFF_MS);
}

/**
 * The backoff wait, cut short by the caller's own signal. A stage deadline or a shutdown must
 * not sit out a 30s retry-after with nothing in flight, which is what `deadline-signal.ts`
 * promises. The timer is unreferenced so a pending wait never holds the process open.
 */
export function backoff(waitMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (abortRequested(signal)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, waitMs);
    timer.unref();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
