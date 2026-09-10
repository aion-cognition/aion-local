import type { Driver } from 'neo4j-driver';
import type * as NodeCrypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { inWriteTransaction } from './connection.js';
import { readManagedWriteObservations } from './managed-write-observations.js';
import { managedWriteGauges } from '../../introspection/domain/managed-write-gauges.js';

const faults = vi.hoisted(() => ({ epoch: false }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomUUID: (...args: Parameters<typeof actual.randomUUID>) => {
      if (faults.epoch) {
        throw new Error('observer epoch fault');
      }
      return actual.randomUUID(...args);
    },
  };
});
afterEach(() => {
  faults.epoch = false;
  vi.restoreAllMocks();
});

function driverWith(closeError?: Error): { driver: Driver; closed: () => number } {
  let closed = 0;
  return {
    driver: {
      session: () => ({
        executeWrite: <T>(body: (tx: unknown) => Promise<T>) => body({}),
        close: () => {
          closed += 1;
          return closeError === undefined ? Promise.resolve() : Promise.reject(closeError);
        },
      }),
    } as unknown as Driver,
    closed: () => closed,
  };
}

it.each([
  { workFails: false, closeFails: false },
  { workFails: true, closeFails: false },
  { workFails: false, closeFails: true },
  { workFails: true, closeFails: true },
])('preserves work=$workFails/close=$closeFails precedence and counts', async (row) => {
  const workError = new Error('work failed');
  const closeError = new Error('close failed');
  const stub = driverWith(row.closeFails ? closeError : undefined);
  const result = await inWriteTransaction(stub.driver, async () => {
    if (row.workFails) {
      throw workError;
    }
    return 'written';
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let expected: { error: Error } | { value: string } = { value: 'written' };
  if (row.closeFails) {
    expected = { error: closeError };
  } else if (row.workFails) {
    expected = { error: workError };
  }
  expect(result).toEqual(expected);
  if ('error' in expected && 'error' in result) {
    expect(result.error).toBe(expected.error);
  }
  expect(stub.closed()).toBe(1);
  const observed = readManagedWriteObservations(stub.driver);
  expect(observed.callerRejections).toBe(Number(row.workFails || row.closeFails));
  expect(observed.callerFulfilments).toBe(Number(!row.workFails && !row.closeFails));
  expect(observed.callbackFailures).toBe(Number(row.workFails));
  expect(observed.callbackAttempts).toBe(1);
});

it('keeps an unidentified accumulation incomplete after identity allocation recovers', async () => {
  const stub = driverWith();
  faults.epoch = true;
  await expect(inWriteTransaction(stub.driver, async () => 'first')).resolves.toBe('first');
  faults.epoch = false;
  await expect(inWriteTransaction(stub.driver, async () => 'second')).resolves.toBe('second');
  const observed = readManagedWriteObservations(stub.driver);
  expect(observed.countsComplete).toBe(false);
  expect(observed.logicalOperations).toBe(2);
  expect(observed.epoch).toBe('unidentified');
  expect(stub.closed()).toBe(2);
  const gauges = managedWriteGauges(observed, '2026-09-09T00:00:00.000Z');
  expect(gauges.size).toBe(11);
  for (const gauge of gauges.values()) {
    expect(gauge).toMatchObject({ status: 'unavailable', reason: 'collector_failed' });
  }
});

it('does not report a fresh clean zero after a failed accumulation installation', async () => {
  const stub = driverWith();
  const original = WeakMap.prototype.set;
  let injected = 0;
  const spy = vi.spyOn(WeakMap.prototype, 'set').mockImplementation(function (
    this: WeakMap<WeakKey, unknown>,
    key: WeakKey,
    value: unknown,
  ) {
    if (key === stub.driver && injected === 0) {
      injected += 1;
      throw new Error('accumulation installation failed');
    }
    return original.call(this, key, value);
  });
  try {
    await expect(inWriteTransaction(stub.driver, async () => 'written')).resolves.toBe('written');
  } finally {
    spy.mockRestore();
  }
  expect(injected).toBe(1);
  expect(stub.closed()).toBe(1);
  const observed = readManagedWriteObservations(stub.driver);
  expect.soft(observed.countsComplete).toBe(false);
  const gauge = managedWriteGauges(observed, '2026-09-09T00:00:00.000Z').get(
    'managed_write_logical_operations',
  );
  expect.soft(gauge).not.toMatchObject({ status: 'measured', value: 0 });
});
