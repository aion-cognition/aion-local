import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteHandle } from './database.js';
import {
  entityMergeDecisionKey,
  getEntityMergeDecisionByKey,
  listEntityMergeDecisions,
} from './entity-merge-decisions.js';
import { listReflectionJobs } from './reflection-queue.js';

const fixtureUrl = new URL('./concurrent-writer.fixture.ts', import.meta.url);
/** Resolves the `.js` specifiers the sources under the fixture are written against. */
const specifierHook = fileURLToPath(new URL('./ts-specifier-hook.fixture.ts', import.meta.url));

type WriterInput = {
  filePath: string;
  label: string;
  rows: number;
  table?: 'entity_merge_decisions';
};

type WriterHandle = {
  ready: Promise<void>;
  /** The ids the writer's own calls returned, in row order. */
  done: Promise<string[]>;
  go: () => void;
};

function spawnWriter(input: WriterInput): WriterHandle {
  const worker = new Worker(fixtureUrl, {
    workerData: input,
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

  const done = new Promise<string[]>((resolve, reject) => {
    worker.on('message', (msg: unknown) => {
      if (typeof msg === 'object' && msg !== null && 'done' in msg) {
        resolve((msg as { done: string[] }).done);
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
  dir = mkdtempSync(join(tmpdir(), 'aion-sqlite-concurrent-'));
  dbPath = join(dir, 'aion.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('two connections racing a fresh file under WAL', () => {
  it('both land every row with no SQLITE_BUSY escaping either connection', async () => {
    const rowsPerWriter = 200;

    const a = spawnWriter({ filePath: dbPath, label: 'writer-a', rows: rowsPerWriter });
    const b = spawnWriter({ filePath: dbPath, label: 'writer-b', rows: rowsPerWriter });

    await Promise.all([a.ready, b.ready]);
    a.go();
    b.go();
    await Promise.all([a.done, b.done]);

    const db = openSqliteHandle({ filePath: dbPath });
    const jobs = listReflectionJobs(db);
    db.close();

    expect(jobs).toHaveLength(rowsPerWriter * 2);

    const countFor = (label: string): number =>
      jobs.filter((job) => (job.payload as { label: string }).label === label).length;
    expect(countFor('writer-a')).toBe(rowsPerWriter);
    expect(countFor('writer-b')).toBe(rowsPerWriter);

    const ids = new Set(jobs.map((job) => job.id));
    expect(ids.size).toBe(jobs.length);
  }, 20_000);
});

/**
 * The claim `recordEntityMergeDecision`'s docstring makes, against the conflict it was written
 * for: the same merge recorded twice leaves one record and both tellings get the first row's
 * id. Above one worker the second telling comes from another connection, and a read-then-insert
 * spelling of the same function is correct on one handle and raises a unique-constraint
 * violation here, so the replay case beside this one cannot stand in for it.
 */
describe('two connections racing the same merge decision key', () => {
  it('leaves one row per key and hands both writers the id the first insert got', async () => {
    const keys = 200;

    const a = spawnWriter({
      filePath: dbPath,
      label: 'writer-a',
      rows: keys,
      table: 'entity_merge_decisions',
    });
    const b = spawnWriter({
      filePath: dbPath,
      label: 'writer-b',
      rows: keys,
      table: 'entity_merge_decisions',
    });

    await Promise.all([a.ready, b.ready]);
    a.go();
    b.go();
    const [idsFromA, idsFromB] = await Promise.all([a.done, b.done]);

    const db = openSqliteHandle({ filePath: dbPath });
    const stored = listEntityMergeDecisions(db);
    const storedIds = Array.from(
      { length: keys },
      (_, i) =>
        getEntityMergeDecisionByKey(
          db,
          entityMergeDecisionKey(`entity-canonical-${i}`, [`entity-member-${i}`], 'cascade-1'),
        )?.id,
    );
    db.close();

    expect(stored).toHaveLength(keys);
    expect(idsFromA).toHaveLength(keys);
    expect(idsFromB).toEqual(idsFromA);
    expect(storedIds).toEqual(idsFromA);
  }, 20_000);
});
