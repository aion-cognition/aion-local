import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import { cueDegradedRate, recordCueOutcome } from './recall-samples.js';

describe('cue degradation rate', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-recall-samples-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads undefined before the first recall rather than a healthy-looking zero', () => {
    expect(cueDegradedRate(store.db)).toBeUndefined();
  });

  it('counts a rate, not a total: 33 degraded means nothing without the 1,469 they came from', () => {
    for (let index = 0; index < 100; index += 1) {
      recordCueOutcome(store.db, index < 17);
    }

    expect(cueDegradedRate(store.db)).toBeCloseTo(0.17, 5);
  });

  it('ages the window out, so an hour of contention does not read as healthy forever', () => {
    for (let index = 0; index < 10; index += 1) {
      recordCueOutcome(store.db, true, 10);
    }
    expect(cueDegradedRate(store.db)).toBe(1);

    for (let index = 0; index < 40; index += 1) {
      recordCueOutcome(store.db, false, 10);
    }

    // The all-time rate would still be 10/50 = 20%; the window has moved past it entirely.
    expect(cueDegradedRate(store.db)).toBe(0);
  });
});
