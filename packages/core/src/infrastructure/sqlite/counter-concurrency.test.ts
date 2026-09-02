import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteHandle } from './database.js';
import { introspectionCycle } from './introspection-counters.js';
import { getMeta } from './meta.js';
import { packMethodCounters, packMethodLegStats } from './method-counters.js';
import { recallCadenceCounters } from './recall-cadence.js';
import { CUE_DEGRADED_META_KEY } from './recall-samples.js';
import { reinforcementFlushCounters } from './reinforcement-queue.js';

const fixtureUrl = new URL('./counter-writer.fixture.ts', import.meta.url);
/** Resolves the `.js` specifiers the sources under the fixture are written against. */
const specifierHook = fileURLToPath(new URL('./ts-specifier-hook.fixture.ts', import.meta.url));

const ROWS_PER_WRITER = 150;

type WriterHandle = {
  ready: Promise<void>;
  done: Promise<number>;
  go: () => void;
};

function spawnWriter(filePath: string): WriterHandle {
  const worker = new Worker(fixtureUrl, {
    workerData: { filePath, rows: ROWS_PER_WRITER },
    execArgv: ['--experimental-strip-types', '--import', specifierHook],
  });

  const ready = new Promise<void>((resolve, reject) => {
    worker.once('message', (msg: unknown) => {
      if (msg === 'ready') {
        resolve();
      } else {
        reject(new Error(`unexpected message before ready: ${String(msg)}`));
      }
    });
    worker.once('error', reject);
  });

  const done = new Promise<number>((resolve, reject) => {
    worker.on('message', (msg: unknown) => {
      if (typeof msg === 'object' && msg !== null && 'done' in msg) {
        resolve((msg as { done: number }).done);
      }
    });
    worker.on('error', reject);
  });

  return {
    ready,
    done,
    go: () => {
      worker.postMessage('go');
    },
  };
}

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-sqlite-counters-'));
  dbPath = join(dir, 'aion.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The service and the CLI open the same store file, so every meta counter is written from more
 * than one connection. A counter that reads a value, adds to it, and writes it back outside a
 * transaction loses whatever the other connection wrote in between, which shows up as a total
 * lower than the calls that produced it.
 */
describe('two connections racing the same meta counters', () => {
  it('lands every increment from both writers', async () => {
    const expected = ROWS_PER_WRITER * 2;

    const a = spawnWriter(dbPath);
    const b = spawnWriter(dbPath);

    await Promise.all([a.ready, b.ready]);
    a.go();
    b.go();
    await Promise.all([a.done, b.done]);

    const db = openSqliteHandle({ filePath: dbPath });
    const methods = packMethodCounters(db);
    const legs = packMethodLegStats(db);
    const cadence = recallCadenceCounters(db);
    const flush = reinforcementFlushCounters(db);
    const cycle = introspectionCycle(db);
    const degradedWindow = getMeta(db, CUE_DEGRADED_META_KEY) ?? '';
    db.close();

    expect(methods.vector).toBe(expected);
    expect(legs.vector).toEqual({ sole: expected, shared: 0, rrfContribution: expected * 2 });
    expect(cadence).toEqual({ totalCalls: expected, emptyPacks: expected });
    expect(flush).toMatchObject({
      signalsApplied: expected,
      pairsApplied: expected,
      edgesUpdated: expected,
    });
    expect(cycle).toBe(expected);
    // One character per recall: a window shorter than the calls means samples were overwritten.
    expect(degradedWindow).toHaveLength(expected);
  }, 30_000);
});
