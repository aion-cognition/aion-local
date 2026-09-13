import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCoverageState } from './coverage-state.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { beginSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';

const NOW = new Date('2026-09-11T06:00:00.000Z');

describe('the coverage state the operator surfaces read', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-coverage-state-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    beginSubstratePairing(store.db, 1);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a substrate with no record as failed rather than as empty coverage', () => {
    expect(readCoverageState(store.db)).toEqual({
      coverageState: 'failed',
      historySince: null,
      coverageEpoch: null,
    });
  });

  it('reports a prepared contract with no horizon', () => {
    const prepared = prepareCoverageContract(store.db, 1);

    expect(readCoverageState(store.db)).toMatchObject({
      coverageState: 'preparing',
      historySince: null,
      coverageEpoch: prepared.epoch,
    });
  });

  it('reports an active contract with the horizon it wrote', () => {
    prepareCoverageContract(store.db, 1);
    const active = activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });

    expect(readCoverageState(store.db)).toMatchObject({
      coverageState: 'active',
      historySince: NOW.toISOString(),
      coverageEpoch: active.epoch,
    });
  });
});
