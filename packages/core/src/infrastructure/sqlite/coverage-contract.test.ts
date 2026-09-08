import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activateCoverageContract,
  coverageEpochIsCurrent,
  COVERAGE_WIRE_CONTRACT_VERSION,
  prepareCoverageContract,
  readCoverageContractRevision,
  readCurrentCoverageContract,
} from './coverage-contract.js';
import { SqliteStore } from './database.js';

const ACTIVATED_AT = new Date('2026-09-08T02:00:00.000Z');

describe('the coverage control record', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-coverage-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('has no record until one is prepared', () => {
    expect(readCurrentCoverageContract(store.db)).toBeUndefined();
  });

  it('prepares without inventing a boundary', () => {
    const prepared = prepareCoverageContract(store.db, 1);

    expect(prepared).toMatchObject({
      registryRevision: 1,
      state: 'preparing',
      historySince: null,
      activatedAt: null,
    });
    expect(readCurrentCoverageContract(store.db)).toEqual(prepared);
  });

  it('activates as a new revision with the boundary, the time and a fresh epoch together', () => {
    const prepared = prepareCoverageContract(store.db, 1);
    const active = activateCoverageContract(store.db, {
      activatedAt: ACTIVATED_AT,
      fieldPolicyVersion: 1,
    });

    expect(active).toMatchObject({
      registryRevision: 2,
      state: 'active',
      historySince: ACTIVATED_AT.toISOString(),
      activatedAt: ACTIVATED_AT.toISOString(),
    });
    expect(active.epoch).not.toBe(prepared.epoch);
    // The preparing revision is still readable as what it was.
    expect(readCoverageContractRevision(store.db, 1)).toEqual(prepared);
    expect(readCurrentCoverageContract(store.db)).toEqual(active);
  });

  it('speaks the same wire version across preparation and activation', () => {
    prepareCoverageContract(store.db, 1);
    activateCoverageContract(store.db, { activatedAt: ACTIVATED_AT, fieldPolicyVersion: 1 });

    expect(
      store.db.prepare('SELECT DISTINCT contract_version FROM coverage_contract').all(),
    ).toEqual([{ contract_version: COVERAGE_WIRE_CONTRACT_VERSION }]);
  });

  it('fences a reader on the epoch rather than on the revision number', () => {
    const prepared = prepareCoverageContract(store.db, 1);
    expect(coverageEpochIsCurrent(store.db, prepared.epoch)).toBe(true);

    const active = activateCoverageContract(store.db, {
      activatedAt: ACTIVATED_AT,
      fieldPolicyVersion: 1,
    });

    expect(coverageEpochIsCurrent(store.db, prepared.epoch)).toBe(false);
    expect(coverageEpochIsCurrent(store.db, active.epoch)).toBe(true);
  });

  it('holds the history boundary still when a later policy revision activates', () => {
    prepareCoverageContract(store.db, 1);
    const first = activateCoverageContract(store.db, {
      activatedAt: ACTIVATED_AT,
      fieldPolicyVersion: 1,
    });
    const later = activateCoverageContract(store.db, {
      activatedAt: new Date('2026-09-08T03:00:00.000Z'),
      fieldPolicyVersion: 2,
    });

    expect(later.historySince).toBe(first.historySince);
    expect(later.activatedAt).toBe(first.activatedAt);
    expect(later.epoch).not.toBe(first.epoch);
    expect(later.fieldPolicyVersion).toBe(2);
  });

  it('leaves an active record alone when initialization is called again', () => {
    prepareCoverageContract(store.db, 1);
    const active = activateCoverageContract(store.db, {
      activatedAt: ACTIVATED_AT,
      fieldPolicyVersion: 1,
    });

    expect(prepareCoverageContract(store.db, 1)).toEqual(active);
    expect(readCurrentCoverageContract(store.db)).toEqual(active);
    expect(store.db.prepare('SELECT count(*) AS n FROM coverage_contract').get()).toEqual({ n: 2 });
  });

  it('initialization called twice before activation opens one revision', () => {
    const first = prepareCoverageContract(store.db, 1);

    expect(prepareCoverageContract(store.db, 2)).toEqual(first);
    expect(store.db.prepare('SELECT count(*) AS n FROM coverage_contract').get()).toEqual({ n: 1 });
  });

  it('an activation retried under its own operation returns the revision it wrote', () => {
    prepareCoverageContract(store.db, 1);
    const activation = {
      activatedAt: ACTIVATED_AT,
      fieldPolicyVersion: 1,
      operationId: 'activation-op',
    };
    const first = activateCoverageContract(store.db, activation);

    expect(activateCoverageContract(store.db, activation)).toEqual(first);
    expect(readCurrentCoverageContract(store.db)).toEqual(first);
    expect(store.db.prepare('SELECT count(*) AS n FROM coverage_contract').get()).toEqual({ n: 2 });
  });

  it('gives every activation its own epoch', () => {
    const first = activateCoverageContract(store.db, {
      activatedAt: ACTIVATED_AT,
      fieldPolicyVersion: 1,
    });
    const second = activateCoverageContract(store.db, {
      activatedAt: ACTIVATED_AT,
      fieldPolicyVersion: 2,
    });

    expect(second.epoch).not.toBe(first.epoch);
    expect(second.registryRevision).toBeGreaterThan(first.registryRevision);
  });
});
