import { DEFAULTS, SqliteStore, type CoverageStateReport, type GraphConnection } from '@aion/core';
import { prepareCoverageContract } from '@aion/core/infrastructure/sqlite/coverage-contract.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coverageCheck, coverageStateCheck } from './doctor-checks.js';
import { buildDoctorChecks } from './doctor.js';

/**
 * The coverage half of `aion doctor`, in its own file so `doctor.test.ts` stays under the line
 * cap. The verdicts are asserted against a real substrate, since what the check is for is the
 * difference between a substrate that promises history and one that does not.
 */

const report = (over: Partial<CoverageStateReport>): CoverageStateReport => ({
  coverageState: 'active',
  historySince: '2026-09-11T06:00:00.000Z',
  coverageEpoch: 'epoch-1',
  evictionGate: 'unarmed',
  evictionCompatibilityRevision: 0,
  evictionDisarmedAt: null,
  ...over,
});

describe('the coverage-state verdict', () => {
  it('passes an active contract and names the horizon it serves from', () => {
    const result = coverageStateCheck(report({}));

    expect(result.ok).toBe(true);
    expect(result.warn).toBeUndefined();
    expect(result.detail).toContain('contract active, history since 2026-09-11T06:00:00.000Z');
  });

  it('warns a preparing contract and says what it costs a temporal read', () => {
    const result = coverageStateCheck(report({ coverageState: 'preparing', historySince: null }));

    expect(result).toMatchObject({ ok: true, warn: true });
    expect(result.detail).toContain('coverage_contract_not_active');
  });

  it('fails a record no reader can serve', () => {
    const result = coverageStateCheck(
      report({ coverageState: 'failed', historySince: null, coverageEpoch: null }),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('every covered read refuses');
  });

  it('says the eviction fence is closed under an active contract and shouts when it is not', () => {
    expect(coverageStateCheck(report({})).detail).toContain('eviction fence closed');

    const armed = coverageStateCheck(
      report({ evictionGate: 'armed', evictionCompatibilityRevision: 2 }),
    );

    expect(armed.detail).toContain('eviction fence ARMED at compatibility revision 2');
  });
});

describe('the coverage-state check over a substrate', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-doctor-coverage-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns on a substrate initialization has prepared and nothing has activated', () => {
    prepareCoverageContract(store.db, 1);

    expect(coverageCheck(store.db)).toMatchObject({ ok: true, warn: true });
  });

  it('fails a substrate carrying no coverage record at all', () => {
    expect(coverageCheck(store.db).ok).toBe(false);
  });

  it('is one of the checks doctor runs', () => {
    const checks = buildDoctorChecks({
      config: DEFAULTS,
      connection: undefined as unknown as GraphConnection,
      db: store.db,
    });

    expect(checks.map((check) => check.name)).toContain('coverage-state');
  });
});
