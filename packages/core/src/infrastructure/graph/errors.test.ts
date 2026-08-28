import { describe, expect, it } from 'vitest';
import { isGraphUnavailable } from './errors.js';

function driverError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('isGraphUnavailable', () => {
  it('is true for the driver codes that mean the server was never reached', () => {
    expect(isGraphUnavailable(driverError('connect ECONNREFUSED', 'ServiceUnavailable'))).toBe(true);
    expect(isGraphUnavailable(driverError('server at address is no longer available', 'SessionExpired'))).toBe(true);
  });

  // The pool raises its own timeout with no code, so the message is the only thing that
  // separates it from every other uncoded driver error.
  it('is true for the connection pool timing out', () => {
    const timedOut = driverError('Connection acquisition timed out in 10000 ms. Pool status: Active conn count = 0', 'N/A');

    expect(isGraphUnavailable(timedOut)).toBe(true);
  });

  it('is false for an answer the server gave, however unwelcome', () => {
    expect(isGraphUnavailable(driverError('constraint violated', 'Neo.ClientError.Schema.ConstraintValidationFailed'))).toBe(false);
    expect(isGraphUnavailable(driverError('Query cannot be null', 'N/A'))).toBe(false);
  });

  it('is false for anything that is not an error carrying a driver code', () => {
    expect(isGraphUnavailable(new Error('plain failure'))).toBe(false);
    expect(isGraphUnavailable({ code: 'ServiceUnavailable' })).toBe(false);
    expect(isGraphUnavailable(undefined)).toBe(false);
  });
});
