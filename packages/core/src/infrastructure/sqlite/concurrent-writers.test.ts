import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteHandle } from './database.js';
import { listReflectionJobs } from './reflection-queue.js';

const fixtureUrl = new URL('./concurrent-writer.fixture.ts', import.meta.url);

type WriterHandle = {
  ready: Promise<void>;
  done: Promise<void>;
  go: () => void;
};

function spawnWriter(filePath: string, label: string, rows: number): WriterHandle {
  const worker = new Worker(fixtureUrl, {
    workerData: { filePath, label, rows },
    execArgv: ['--experimental-strip-types'],
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

  const done = new Promise<void>((resolve, reject) => {
    worker.on('message', (msg: unknown) => {
      if (msg === 'done') {
        resolve();
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

describe('two connections racing a fresh file under WAL', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-sqlite-concurrent-'));
    dbPath = join(dir, 'aion.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('both land every row with no SQLITE_BUSY escaping either connection', async () => {
    const rowsPerWriter = 200;

    const a = spawnWriter(dbPath, 'writer-a', rowsPerWriter);
    const b = spawnWriter(dbPath, 'writer-b', rowsPerWriter);

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
