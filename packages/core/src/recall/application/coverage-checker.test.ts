import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkCoverage,
  CoverageRequestError,
  readCoverageFence,
  type CoverageCheck,
} from './coverage-checker.js';
import { isTimeTravel } from '../../infrastructure/graph/read-modes.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const H = new Date('2026-09-08T02:00:00.000Z');

let dir: string;
let store: SqliteStore;

function check(request: { asOf?: string; knewAt?: string; now?: Date }): CoverageCheck {
  return checkCoverage(store.db, {
    ...(request.asOf === undefined ? {} : { asOf: request.asOf }),
    ...(request.knewAt === undefined ? {} : { knewAt: request.knewAt }),
    now: request.now ?? NOW,
    expiryAnnotation: true,
  });
}

function activate(): void {
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: H, fieldPolicyVersion: 1 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-coverage-check-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('with no coverage record at all', () => {
  it('refuses a temporal request rather than answering from an unknown contract', () => {
    expect(check({ knewAt: '2026-09-08T05:00:00.000Z' })).toEqual({
      status: 'refused',
      refusal: {
        contract_version: 1,
        reason: 'coverage_store_unavailable',
        requested: { knew_at: '2026-09-08T05:00:00.000Z', now: NOW.toISOString() },
        bounds: {},
      },
    });
  });

  it('refuses a present request too, since nothing can say what any answer covers', () => {
    expect(check({})).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_store_unavailable', bounds: {} },
    });
  });

  it('offers no epoch to fence a completion against', () => {
    expect(readCoverageFence(store.db)).toBeUndefined();
  });
});

describe('with a record that does not say what it is', () => {
  it('refuses when the state and its boundary disagree', () => {
    prepareCoverageContract(store.db, 1);
    // The schema forbids writing this row, so a substrate holding one was written by something
    // whose schema did not. The reader refuses it either way rather than trusting the state word.
    store.db.pragma('ignore_check_constraints = ON');
    store.db.prepare('UPDATE coverage_contract SET state = ?').run('active');
    store.db.pragma('ignore_check_constraints = OFF');

    expect(check({ knewAt: '2026-09-08T05:00:00.000Z' })).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_store_unavailable' },
    });
    expect(readCoverageFence(store.db)).toBeUndefined();
  });

  it('refuses a wire contract version this reader does not speak', () => {
    activate();
    store.db.prepare('UPDATE coverage_contract SET contract_version = 2').run();

    expect(check({})).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_store_unavailable' },
    });
  });

  it('refuses a field policy whose limits this reader cannot apply', () => {
    activate();
    store.db.prepare('UPDATE coverage_contract SET field_policy_version = 2').run();

    expect(check({})).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_store_unavailable' },
    });
  });

  it('refuses when the table itself cannot be read', () => {
    activate();
    store.db.prepare('DROP TABLE coverage_contract').run();

    expect(check({})).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_store_unavailable' },
    });
    expect(readCoverageFence(store.db)).toBeUndefined();
  });
});

describe('while the record is preparing', () => {
  beforeEach(() => {
    prepareCoverageContract(store.db, 1);
  });

  it('answers a knowledge-time request as partial, with no invented boundary', () => {
    const result = check({ knewAt: '2026-09-08T05:00:00.000Z' });
    if (result.status !== 'checked') {
      throw new Error('a readable preparing record answers');
    }

    expect(result.coverage).toEqual({
      contract_version: 1,
      status: 'partial',
      knew_at: '2026-09-08T05:00:00.000Z',
      limitations: ['coverage_contract_not_active'],
      gaps: [],
    });
    expect(result.coverage.history_since).toBeUndefined();
    expect(result.context.coverageState).toBe('preparing');
    expect(isTimeTravel(result.context.mode)).toBe(true);
  });

  it('keeps a present request supported and still names the inactive contract', () => {
    const result = check({});
    if (result.status !== 'checked') {
      throw new Error('a readable preparing record answers');
    }

    expect(result.coverage.status).toBe('supported');
    expect(result.coverage.limitations).toEqual(['coverage_contract_not_active']);
    expect(result.coverage.history_since).toBeUndefined();
    expect(isTimeTravel(result.context.mode)).toBe(false);
  });

  it('refuses knowledge past the request clock, which no contract can supply', () => {
    expect(check({ knewAt: '2026-09-09T00:00:00.000Z' })).toMatchObject({
      status: 'refused',
      refusal: { reason: 'future_knowledge', bounds: { coverage_state: 'preparing' } },
    });
  });

  it('has no boundary to refuse an old knowledge time against', () => {
    expect(check({ knewAt: '2020-01-01T00:00:00.000Z' })).toMatchObject({ status: 'checked' });
  });

  it('fences a completion on the preparing epoch', () => {
    expect(readCoverageFence(store.db)).toBe(
      store.db.prepare('SELECT epoch FROM coverage_contract').pluck().get(),
    );
  });
});

describe('with an active record', () => {
  beforeEach(() => {
    activate();
  });

  it('states the boundary on every answer it checks, present requests included', () => {
    const result = check({});
    if (result.status !== 'checked') {
      throw new Error('an active record answers');
    }

    expect(result.coverage).toEqual({
      contract_version: 1,
      history_since: H.toISOString(),
      status: 'supported',
      limitations: [],
      gaps: [],
    });
    expect(result.context).toMatchObject({
      coverageState: 'active',
      historySince: H.toISOString(),
      contractVersion: 1,
      fieldPolicyVersion: 1,
      now: NOW,
    });
  });

  it('refuses a knowledge time before the boundary and says what the boundary is', () => {
    expect(check({ knewAt: '2026-09-08T01:59:59.999Z' })).toEqual({
      status: 'refused',
      refusal: {
        contract_version: 1,
        reason: 'before_horizon',
        requested: { knew_at: '2026-09-08T01:59:59.999Z', now: NOW.toISOString() },
        bounds: { history_since: H.toISOString(), coverage_state: 'active' },
      },
    });
  });

  it('answers at the boundary itself, which is inclusive', () => {
    expect(check({ knewAt: H.toISOString() })).toMatchObject({ status: 'checked' });
  });

  it('keeps a world time older than the boundary eligible under present knowledge', () => {
    const result = check({ asOf: '2019-05-05T00:00:00.000Z' });
    if (result.status !== 'checked') {
      throw new Error('an old world time asks about present belief');
    }

    expect(result.coverage.as_of).toBe('2019-05-05T00:00:00.000Z');
    expect(result.context.mode.validAt).toEqual(new Date('2019-05-05T00:00:00.000Z'));
    expect(result.context.mode.knownAt).toBeUndefined();
  });

  it('reads a future world time as present belief and a future knowledge time as refusal', () => {
    expect(check({ asOf: '2030-01-01T00:00:00.000Z' })).toMatchObject({ status: 'checked' });
    expect(check({ knewAt: '2026-09-08T06:00:00.001Z' })).toMatchObject({
      status: 'refused',
      refusal: { reason: 'future_knowledge' },
    });
  });

  it('checks the knowledge time of a two-axis request without substituting the world time', () => {
    expect(
      check({ asOf: '2019-01-01T00:00:00.000Z', knewAt: '2026-09-08T01:00:00.000Z' }),
    ).toMatchObject({ status: 'refused', refusal: { reason: 'before_horizon' } });

    const result = check({ asOf: '2019-01-01T00:00:00.000Z', knewAt: '2026-09-08T03:00:00.000Z' });
    if (result.status !== 'checked') {
      throw new Error('a knowledge time inside the boundary answers');
    }

    expect(result.context.mode.validAt).toEqual(new Date('2019-01-01T00:00:00.000Z'));
    expect(result.context.mode.knownAt).toEqual(new Date('2026-09-08T03:00:00.000Z'));
  });

  it('carries the epoch in force as the fence a completion is judged against', () => {
    const result = check({});
    if (result.status !== 'checked') {
      throw new Error('an active record answers');
    }

    expect(result.context.coverageEpoch).toBe(readCoverageFence(store.db));
  });

  it('moves the fence when the record is revised under a running read', () => {
    const before = readCoverageFence(store.db);
    activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });

    expect(readCoverageFence(store.db)).not.toBe(before);
  });
});

describe('the timestamp grammar', () => {
  beforeEach(() => {
    activate();
  });

  it('normalizes a date-only input to UTC midnight on both axes', () => {
    const result = check({
      asOf: '2026-03-01',
      knewAt: '2026-09-09',
      now: new Date('2026-09-10T06:00:00.000Z'),
    });
    if (result.status !== 'checked') {
      throw new Error('a date-only request is inside the grammar');
    }

    expect(result.coverage.as_of).toBe('2026-03-01T00:00:00.000Z');
    expect(result.coverage.knew_at).toBe('2026-09-09T00:00:00.000Z');
    expect(result.context.mode.knownAt).toEqual(new Date('2026-09-09T00:00:00.000Z'));
  });

  it('puts a date-only knowledge time before the boundary outside the contract', () => {
    expect(check({ knewAt: '2026-09-08' })).toMatchObject({
      status: 'refused',
      refusal: { reason: 'before_horizon', requested: { knew_at: '2026-09-08T00:00:00.000Z' } },
    });
  });

  it('rejects what the wire would reject, so two entry points read one date alike', () => {
    expect(() => check({ knewAt: 'March 1 2026' })).toThrow(CoverageRequestError);
    expect(() => check({ asOf: '2026-03-01 12:00:00' })).toThrow(CoverageRequestError);
    expect(() => check({ knewAt: 'yesterday' })).toThrow(
      /knew_at must be an ISO 8601 date or datetime/,
    );
  });

  it('keeps an offset input at the instant it names', () => {
    const result = check({ knewAt: '2026-09-08T04:00:00.000+02:00' });
    if (result.status !== 'checked') {
      throw new Error('an offset request is inside the grammar');
    }

    expect(result.coverage.knew_at).toBe('2026-09-08T02:00:00.000Z');
  });
});
