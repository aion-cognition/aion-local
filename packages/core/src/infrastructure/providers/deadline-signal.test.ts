import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';

import { deadlineFor } from './deadline-signal.js';

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('deadlineFor', () => {
  it('leaves the signal open while the call has time left', () => {
    const deadline = deadlineFor(60_000);

    expect(deadline.signal.aborted).toBe(false);
    deadline.clear();
  });

  it("aborts on the call's own timeout", async () => {
    const deadline = deadlineFor(5);

    await tick(25);

    expect(deadline.signal.aborted).toBe(true);
    deadline.clear();
  });

  it('aborts the moment the caller does, without waiting for the timeout', () => {
    const caller = new AbortController();
    const deadline = deadlineFor(60_000, caller.signal);

    caller.abort();

    expect(deadline.signal.aborted).toBe(true);
    deadline.clear();
  });

  it('comes back already aborted when the caller stopped before the call started', () => {
    const caller = new AbortController();
    caller.abort();

    const deadline = deadlineFor(60_000, caller.signal);

    expect(deadline.signal.aborted).toBe(true);
    deadline.clear();
  });

  /** The caller's signal lives as long as the service, so a listener left on it never leaves. */
  it('takes its listener back off the caller signal on clear', () => {
    const caller = new AbortController();

    for (let call = 0; call < 3; call += 1) {
      deadlineFor(60_000, caller.signal).clear();
    }

    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('stops the timer on clear, so a call that answered early aborts nothing later', async () => {
    const deadline = deadlineFor(5);
    deadline.clear();

    await tick(25);

    expect(deadline.signal.aborted).toBe(false);
  });
});
