import { readSubstratePairing, SqliteStore } from '@aion/core';
import { beginSubstratePairing } from '@aion/core/infrastructure/sqlite/publication-control.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { healthPayload } from './health.js';

/**
 * The store identity `/health` reports, read through the handle the process is serving from.
 * Nothing here boots a service, opens a port or talks to a provider: the reader is the function
 * `bootstrap.ts` hands the service, exercised against temporary stores.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-health-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sources(storeIdentity: (() => string | undefined) | undefined) {
  return {
    sessions: 0,
    queueLag: undefined,
    plasticity: undefined,
    coverage: undefined,
    storeIdentity,
  };
}

describe('the store identity on the health payload', () => {
  it('omits the key for a service constructed without the reader', () => {
    expect(healthPayload(sources(undefined))).not.toHaveProperty('store_id');
  });

  it('reports the id the substrate minted, read through the open handle', () => {
    const store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    try {
      const paired = beginSubstratePairing(store.db, 1);

      const payload = healthPayload(sources(() => readSubstratePairing(store.db)?.substrateId));

      expect(payload.store_id).toBe(paired.substrateId);
    } finally {
      store.close();
    }
  });

  /**
   * A substrate nothing has paired yet is a different reading from a service too old to report
   * one, and a probe that cannot tell them apart would read the second as the first.
   */
  it('reports null for a store no service has paired yet', () => {
    const store = new SqliteStore({ filePath: join(dir, 'unpaired.sqlite') });
    try {
      const payload = healthPayload(sources(() => readSubstratePairing(store.db)?.substrateId));

      expect(payload.store_id).toBeNull();
    } finally {
      store.close();
    }
  });

  /**
   * The whole point of reading it through the handle. The file at the pathname is replaced while
   * the first handle stays open, and the payload keeps naming the store that handle holds — which
   * is what lets an installation tell a service on the current substrate from one still serving
   * the file that used to be there.
   */
  it('follows the handle rather than the pathname when the file is replaced underneath it', () => {
    const filePath = join(dir, 'aion.sqlite');
    const held = new SqliteStore({ filePath });
    try {
      const first = beginSubstratePairing(held.db, 1);
      rmSync(filePath, { force: true });
      rmSync(`${filePath}-wal`, { force: true });
      rmSync(`${filePath}-shm`, { force: true });
      const replacement = new SqliteStore({ filePath });
      const second = beginSubstratePairing(replacement.db, 1);
      replacement.close();
      expect(second.substrateId).not.toBe(first.substrateId);

      const payload = healthPayload(sources(() => readSubstratePairing(held.db)?.substrateId));

      expect(payload.store_id).toBe(first.substrateId);
    } finally {
      held.close();
    }
  });
});
