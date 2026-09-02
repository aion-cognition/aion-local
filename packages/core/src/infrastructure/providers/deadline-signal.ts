/**
 * One signal per provider call: the call's own timeout, with the caller's signal layered under
 * it, so a shutdown never waits out a model call with most of its timeout left. Every
 * reflection stage and every introspection judge composes the two this way.
 *
 * Two paths build a bare timeout with no caller signal, because neither has one to compose:
 * recall's cue call, which runs under a latency budget rather than under a shutdown, and
 * narrative compression, which the sweeper drives on its own clock.
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

/**
 * Reads a signal through a call, so a second check inside one function is a real read. Nothing
 * in the function aborts the signal, so control-flow analysis holds `signal?.aborted` at
 * whatever the first check settled and calls the one after the wait dead. The abort arrives
 * from outside, and the wait is exactly where it lands.
 */
export function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
