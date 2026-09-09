import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { inWriteTransaction } from './connection.js';
import { readManagedWriteObservations } from './managed-write-observations.js';

/**
 * The managed driver replays a write callback and hands the caller the eventual outcome, so
 * the only place a replay is visible is the invocation itself. These stubs replay the way the
 * driver does: a scripted failure on the first invocation, then another invocation, with the
 * caller told nothing. Scripting the failure is what makes the replay deterministic; the
 * retry budget could not do it, since the driver measures the budget against elapsed time.
 */

const TX = { run: () => Promise.resolve({ records: [], summary: undefined }) };

const DEADLOCK = 'Neo.TransientError.Transaction.DeadlockDetected';
const OUT_OF_MEMORY = 'Neo.TransientError.General.MemoryPoolOutOfMemoryError';
const SYNTAX = 'Neo.ClientError.Statement.SyntaxError';

function coded(code: string): Error {
  return Object.assign(new Error(`server said ${code}`), { code });
}

/** An error whose code cannot be read at all, which is what breaks the bookkeeping. */
function unreadable(): Error {
  const err = new Error('code is not readable');
  Object.defineProperty(err, 'code', {
    get(): string {
      throw new Error('reading the code failed');
    },
  });
  return err;
}

function isTransient(err: unknown): boolean {
  const { code } = err as { code?: unknown };
  return typeof code === 'string' && code.startsWith('Neo.TransientError');
}

type RetryOptions = {
  readonly retries: number;
  readonly retryable?: (err: unknown) => boolean;
};

function retryingDriver(options: RetryOptions): Driver {
  const retryable = options.retryable ?? isTransient;
  const session = {
    async executeWrite<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      let remaining = options.retries;
      for (;;) {
        try {
          return await work(TX);
        } catch (err) {
          if (remaining <= 0 || !retryable(err)) {
            throw err;
          }
          remaining -= 1;
        }
      }
    },
    close: () => Promise.resolve(),
  };
  return { session: () => session } as unknown as Driver;
}

/** A commit that failed after the body returned: the body runs again and never sees the error. */
function commitReplayingDriver(): Driver {
  const session = {
    async executeWrite<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      await work(TX);
      return work(TX);
    },
    close: () => Promise.resolve(),
  };
  return { session: () => session } as unknown as Driver;
}

/** A body that fails with each scripted code in turn, then answers. */
function failingThen<T>(codes: readonly string[], answer: T): () => Promise<T> {
  let attempt = 0;
  return () => {
    const code = codes[attempt];
    attempt += 1;
    if (code === undefined) {
      return Promise.resolve(answer);
    }
    return Promise.reject(coded(code));
  };
}

describe('managed write observations', () => {
  it('counts a replayed callback and the class it was replayed for', async () => {
    const driver = retryingDriver({ retries: 1 });
    const body = failingThen([DEADLOCK], 'written');

    await expect(inWriteTransaction(driver, body)).resolves.toBe('written');

    const observed = readManagedWriteObservations(driver);
    expect(observed.logicalOperations).toBe(1);
    expect(observed.callbackAttempts).toBe(2);
    expect(observed.callbackReplays).toBe(1);
    expect(observed.replaysByClass).toEqual({
      deadlock: 1,
      other_transient: 0,
      outside_callback: 0,
    });
    expect(observed.callbackFailures).toBe(1);
    expect(observed.failuresByCode).toEqual({ [DEADLOCK]: 1 });
    expect(observed.callerFulfilments).toBe(1);
    expect(observed.callerRejections).toBe(0);
    expect(observed.observerFailures).toBe(0);
  });

  it('counts no replay when the callback ran once', async () => {
    const driver = retryingDriver({ retries: 1 });

    await expect(inWriteTransaction(driver, () => Promise.resolve('written'))).resolves.toBe(
      'written',
    );

    const observed = readManagedWriteObservations(driver);
    expect(observed.callbackAttempts).toBe(1);
    expect(observed.callbackReplays).toBe(0);
    expect(observed.replaysByClass).toEqual({
      deadlock: 0,
      other_transient: 0,
      outside_callback: 0,
    });
    expect(observed.callbackFailures).toBe(0);
    expect(observed.failuresByCode).toEqual({});
    expect(observed.callerFulfilments).toBe(1);
  });

  it('reports a driver that has run no managed write as a zero of its own', () => {
    const observed = readManagedWriteObservations(retryingDriver({ retries: 0 }));

    expect(observed.logicalOperations).toBe(0);
    expect(observed.callbackReplays).toBe(0);
    expect(observed.epoch).not.toBe('');
  });

  it('separates a transient failure that is not a lock cycle', async () => {
    const driver = retryingDriver({ retries: 1 });

    await inWriteTransaction(driver, failingThen([OUT_OF_MEMORY], 'written'));

    const observed = readManagedWriteObservations(driver);
    expect(observed.callbackReplays).toBe(1);
    expect(observed.replaysByClass.other_transient).toBe(1);
    expect(observed.replaysByClass.deadlock).toBe(0);
    expect(observed.failuresByCode).toEqual({ [OUT_OF_MEMORY]: 1 });
  });

  it('counts a terminal failure as a failure and not as a replay', async () => {
    const driver = retryingDriver({ retries: 3 });

    await expect(inWriteTransaction(driver, failingThen([SYNTAX], 'unreached'))).rejects.toThrow(
      SYNTAX,
    );

    const observed = readManagedWriteObservations(driver);
    expect(observed.callbackAttempts).toBe(1);
    expect(observed.callbackReplays).toBe(0);
    expect(observed.callbackFailures).toBe(1);
    expect(observed.failuresByCode).toEqual({ [SYNTAX]: 1 });
    expect(observed.callerRejections).toBe(1);
    expect(observed.callerFulfilments).toBe(0);
  });

  it('names a replay whose cause the callback never saw', async () => {
    const driver = commitReplayingDriver();

    await inWriteTransaction(driver, () => Promise.resolve('written'));

    const observed = readManagedWriteObservations(driver);
    expect(observed.callbackAttempts).toBe(2);
    expect(observed.callbackReplays).toBe(1);
    expect(observed.replaysByClass.outside_callback).toBe(1);
    expect(observed.callbackFailures).toBe(0);
    expect(observed.callerFulfilments).toBe(1);
  });

  it('accounts for every invocation across several calls', async () => {
    const driver = retryingDriver({ retries: 2 });

    await inWriteTransaction(driver, failingThen([DEADLOCK, DEADLOCK], 'written'));
    await inWriteTransaction(driver, () => Promise.resolve('written'));
    await expect(
      inWriteTransaction(driver, failingThen([SYNTAX], 'unreached')),
    ).rejects.toBeInstanceOf(Error);

    const observed = readManagedWriteObservations(driver);
    expect(observed.logicalOperations).toBe(3);
    expect(observed.callbackAttempts).toBe(observed.logicalOperations + observed.callbackReplays);
    expect(observed.callbackReplays).toBe(2);
    expect(observed.callerFulfilments + observed.callerRejections).toBe(3);
  });

  it('hands back the error object the body raised', async () => {
    const driver = retryingDriver({ retries: 0 });
    const raised = coded(SYNTAX);

    await expect(inWriteTransaction(driver, () => Promise.reject(raised))).rejects.toBe(raised);
  });

  it('answers the caller normally when the bookkeeping itself fails', async () => {
    const driver = retryingDriver({ retries: 1, retryable: () => true });
    const raised = unreadable();
    let attempt = 0;
    const body = (): Promise<string> => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(raised) : Promise.resolve('written');
    };

    await expect(inWriteTransaction(driver, body)).resolves.toBe('written');

    const observed = readManagedWriteObservations(driver);
    expect(observed.observerFailures).toBe(1);
    expect(observed.callerFulfilments).toBe(1);
    expect(observed.callbackAttempts).toBe(2);
    // The class the replay continued was never established, so the replay count is a floor and
    // the observer failure above is what says so.
    expect(observed.callbackReplays).toBe(0);
  });

  it('counts each driver on its own', async () => {
    const left = retryingDriver({ retries: 1 });
    const right = retryingDriver({ retries: 1 });

    await inWriteTransaction(left, failingThen([DEADLOCK], 'written'));
    await inWriteTransaction(right, () => Promise.resolve('written'));

    const observedLeft = readManagedWriteObservations(left);
    const observedRight = readManagedWriteObservations(right);
    expect(observedLeft.callbackReplays).toBe(1);
    expect(observedRight.callbackReplays).toBe(0);
    expect(observedLeft.epoch).not.toBe(observedRight.epoch);
  });

  it('bounds the codes a summary names', async () => {
    const driver = retryingDriver({ retries: 0 });

    for (let index = 0; index < 20; index += 1) {
      await expect(
        inWriteTransaction(driver, failingThen([`Neo.ClientError.Test.Code${String(index)}`], 'x')),
      ).rejects.toBeInstanceOf(Error);
    }

    const observed = readManagedWriteObservations(driver);
    expect(Object.keys(observed.failuresByCode)).toHaveLength(16);
    expect(observed.failureCodesTruncated).toBe(true);
    expect(observed.callbackFailures).toBe(20);
  });
});
