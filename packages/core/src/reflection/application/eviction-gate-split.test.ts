import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { durableEligibility } from './eviction-eligibility.js';
import { activateCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  beginSubstratePairing,
  completeSubstratePairing,
  establishActivationCapability,
  readSubstratePairing,
} from '../../infrastructure/sqlite/publication-control.js';

/**
 * The two gates on the publication control row, held apart.
 *
 * A substrate the ordinary startup brought all the way to an active coverage contract is still
 * a substrate nothing may be removed from. These cases fail if the eviction fence is ever
 * rewired to read the coverage capability, which is the shape it had before the split.
 */

const NOW = new Date('2026-09-11T06:00:00.000Z');
const POLICY = { now: NOW, minAgeMs: 0 };

describe('coverage activation and the eviction fence are separate gates', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-gate-split-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    const pairing = beginSubstratePairing(store.db, 1);
    completeSubstratePairing(store.db, pairing.substrateId);
    establishActivationCapability(store.db, 1);
    activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a substrate with the coverage capability established and the fence closed', () => {
    expect(readSubstratePairing(store.db)).toMatchObject({
      bootstrapState: 'initialized',
      activationCapabilityRevision: 1,
      evictionCompatibilityRevision: 0,
    });
  });

  it('refuses eviction on a substrate whose coverage contract is active', () => {
    expect(durableEligibility(store.db, 'any-source', POLICY)).toEqual({
      status: 'pinned',
      reason: 'compatibility_not_established',
    });
  });

  it('passes the fence only once the eviction compatibility revision is set', () => {
    store.db.prepare('UPDATE publication_control SET eviction_compatibility_revision = 1').run();

    expect(durableEligibility(store.db, 'any-source', POLICY)).toEqual({
      status: 'pinned',
      reason: 'source_record_missing',
    });
  });

  it('leaves the fence closed when the coverage capability moves on its own', () => {
    establishActivationCapability(store.db, 2);

    expect(readSubstratePairing(store.db)?.evictionCompatibilityRevision).toBe(0);
    expect(durableEligibility(store.db, 'any-source', POLICY)).toEqual({
      status: 'pinned',
      reason: 'compatibility_not_established',
    });
  });
});
