/**
 * One signal per provider call: the call's own timeout, with the caller's signal layered
 * under it. Every judge and every operation that generates composes the two this way, so a
 * shutdown never waits out a model call with most of its timeout left.
 *
 * `clear` is the other half of the contract, and every caller runs it on every path. It stops
 * the timer a call that answered early left running, and it takes the abort listener back off
 * the caller's signal. That signal lives as long as the service, so a listener left on it
 * accumulates one entry per call for the life of the process.
 */

export type Deadline = {
  readonly signal: AbortSignal;
  readonly clear: () => void;
};

export function deadlineFor(timeoutMs: number, callerSignal?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => {
    controller.abort();
  };
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    clear: (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}
