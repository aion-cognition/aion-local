import { Neo4jError, isRetryableError, type Driver } from 'neo4j-driver';
import type * as NodeCrypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { inWriteTransaction } from './connection.js';
import { readManagedWriteObservations } from './managed-write-observations.js';
import { managedWriteGauges } from '../../introspection/domain/managed-write-gauges.js';

const faults = vi.hoisted(() => ({ uuid: false }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomUUID: (...args: Parameters<typeof actual.randomUUID>) => {
      if (faults.uuid) {
        throw new Error('observer epoch unavailable');
      }
      return actual.randomUUID(...args);
    },
  };
});

afterEach(() => {
  faults.uuid = false;
});

type Stub = {
  readonly driver: Driver;
  readonly closed: () => number;
};

/** The driver owns retry decisions; this fixture scripts exactly the attempts requested. */
function driverWith(retries = 0, closeError?: Error): Stub {
  let closes = 0;
  const session = {
    async executeWrite<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await work({ run: () => Promise.resolve({ records: [] }) });
        } catch (err) {
          if (attempt >= retries) {
            throw err;
          }
        }
      }
    },
    close: () => {
      closes += 1;
      return closeError === undefined ? Promise.resolve() : Promise.reject(closeError);
    },
  };
  return { driver: { session: () => session } as unknown as Driver, closed: () => closes };
}

it('keeps a successful write and its cleanup independent of observer initialization', async () => {
  const stub = driverWith();
  let writes = 0;
  faults.uuid = true;
  const outcome = await inWriteTransaction(stub.driver, async () => {
    writes += 1;
    return 'committed';
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  expect.soft(outcome).toEqual({ value: 'committed' });
  expect.soft(writes).toBe(1);
  expect.soft(stub.closed()).toBe(1);
});

it('control: a normal observer preserves the same successful write', async () => {
  const stub = driverWith();
  await expect(inWriteTransaction(stub.driver, async () => 'committed')).resolves.toBe('committed');
  expect(stub.closed()).toBe(1);
  expect(readManagedWriteObservations(stub.driver).callerFulfilments).toBe(1);
});

it('counts a cleanup rejection as the rejection the wrapper caller received', async () => {
  const closeError = new Error('session close failed');
  const stub = driverWith(0, closeError);
  await expect(inWriteTransaction(stub.driver, async () => 'committed')).rejects.toBe(closeError);
  const observed = readManagedWriteObservations(stub.driver);
  expect.soft(observed.callerRejections).toBe(1);
  expect.soft(observed.callerFulfilments).toBe(0);
  expect(observed.callbackFailures).toBe(0);
  expect(stub.closed()).toBe(1);
});

it('never credits a previous deadlock as the cause of a later unreadable failure', async () => {
  const stub = driverWith(2);
  const deadlock = Object.assign(new Error('first failure'), {
    code: 'Neo.TransientError.Transaction.DeadlockDetected',
  });
  const unreadable = new Neo4jError(
    'second failure',
    'Neo.TransientError.General.DatabaseUnavailable',
    '50N42',
    'scripted failure',
  );
  Object.defineProperty(unreadable, 'code', {
    get() {
      throw new Error('observer cannot read this code');
    },
  });
  expect(isRetryableError(unreadable)).toBe(true);
  let attempt = 0;
  await expect(
    inWriteTransaction(stub.driver, async () => {
      attempt += 1;
      if (attempt === 1) {
        throw deadlock;
      }
      if (attempt === 2) {
        throw unreadable;
      }
      return 'committed';
    }),
  ).resolves.toBe('committed');
  const observed = readManagedWriteObservations(stub.driver);
  expect(observed.callbackAttempts).toBe(3);
  expect(observed.callbackReplays).toBe(2);
  expect(observed.observerFailures).toBe(1);
  expect(observed.replaysByClass.deadlock).toBe(1);
});

it('does not publish a known-incomplete replay count as an exact measured zero', async () => {
  const stub = driverWith(1);
  const unreadable = new Neo4jError(
    'failure with an unreadable code',
    'Neo.TransientError.General.DatabaseUnavailable',
    '50N42',
    'scripted failure',
  );
  Object.defineProperty(unreadable, 'code', {
    get() {
      throw new Error('observer cannot read this code');
    },
  });
  expect(isRetryableError(unreadable)).toBe(true);
  let attempt = 0;
  await inWriteTransaction(stub.driver, async () => {
    attempt += 1;
    if (attempt === 1) {
      throw unreadable;
    }
    return 'committed';
  });
  const observed = readManagedWriteObservations(stub.driver);
  expect(observed.observerFailures).toBe(1);
  const gauge = managedWriteGauges(observed, '2026-09-09T00:00:00.000Z').get(
    'managed_write_callback_replays',
  );
  // Either count this observable replay correctly or disclose unavailable/incomplete evidence.
  expect(gauge).not.toMatchObject({ status: 'measured', value: 0 });
});

it('control: an unobserved begin failure is not itself a callback replay', async () => {
  const error = new Error('begin never invoked the body');
  const driver = {
    session: () => ({
      executeWrite: () => Promise.reject(error),
      close: () => Promise.resolve(),
    }),
  } as unknown as Driver;
  await expect(inWriteTransaction(driver, async () => 'unreached')).rejects.toBe(error);
  const observed = readManagedWriteObservations(driver);
  expect(observed.callbackAttempts).toBe(0);
  expect(observed.callbackReplays).toBe(0);
  expect(observed.callerRejections).toBe(1);
});
