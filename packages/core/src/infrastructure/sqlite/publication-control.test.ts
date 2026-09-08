import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  advanceAckCursor,
  beginSubstratePairing,
  completeSubstratePairing,
  readSubstratePairing,
  setPendingOperation,
} from './publication-control.js';

describe('substrate pairing', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-pairing-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints one identity and joins it on every call after', () => {
    expect(readSubstratePairing(store.db)).toBeUndefined();

    const first = beginSubstratePairing(store.db, 1);
    const second = beginSubstratePairing(store.db, 1);

    expect(first.bootstrapState).toBe('pairing');
    expect(second).toEqual(first);
    expect(store.db.prepare('SELECT count(*) AS n FROM publication_control').get()).toEqual({
      n: 1,
    });
  });

  it('a second connection joins the identity the first minted rather than writing its own', () => {
    const path = join(dir, 'shared.sqlite');
    const first = new SqliteStore({ filePath: path });
    const second = new SqliteStore({ filePath: path });
    try {
      const minted = beginSubstratePairing(first.db, 1);
      const joined = beginSubstratePairing(second.db, 1);

      expect(joined.substrateId).toBe(minted.substrateId);
      expect(second.db.prepare('SELECT count(*) AS n FROM publication_control').get()).toEqual({
        n: 1,
      });
    } finally {
      second.close();
      first.close();
    }
  });

  it('closes the bootstrap once and reports a second close as nothing to do', () => {
    const pairing = beginSubstratePairing(store.db, 1);

    expect(completeSubstratePairing(store.db, pairing.substrateId)).toBe(true);
    expect(readSubstratePairing(store.db)?.bootstrapState).toBe('initialized');
    expect(completeSubstratePairing(store.db, pairing.substrateId)).toBe(false);
  });

  it('an interrupted pairing is still open on the next open', () => {
    const path = join(dir, 'interrupted.sqlite');
    const first = new SqliteStore({ filePath: path });
    const minted = beginSubstratePairing(first.db, 1);
    first.close();

    const reopened = new SqliteStore({ filePath: path });
    try {
      expect(beginSubstratePairing(reopened.db, 1)).toEqual({
        ...minted,
        bootstrapState: 'pairing',
      });
    } finally {
      reopened.close();
    }
  });

  it('moves the acknowledgment cursor forward only', () => {
    beginSubstratePairing(store.db, 1);

    expect(advanceAckCursor(store.db, 4, '2026-09-08T02:00:00.000Z')).toBe(true);
    expect(advanceAckCursor(store.db, 2, '2026-09-08T01:00:00.000Z')).toBe(false);
    expect(readSubstratePairing(store.db)).toMatchObject({
      lastAckSequence: 4,
      lastKnownFrom: '2026-09-08T02:00:00.000Z',
    });
  });

  it('names the operation the substrate waits on and clears it again', () => {
    beginSubstratePairing(store.db, 1);

    setPendingOperation(store.db, 'op-1');
    expect(readSubstratePairing(store.db)?.pendingOperationId).toBe('op-1');

    setPendingOperation(store.db, undefined);
    expect(readSubstratePairing(store.db)?.pendingOperationId).toBeNull();
  });

  it('refuses a bootstrap state the machine does not have', () => {
    beginSubstratePairing(store.db, 1);

    expect(() =>
      store.db.prepare("UPDATE publication_control SET bootstrap_state = 'done'").run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
