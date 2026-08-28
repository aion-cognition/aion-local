import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteHandle } from './database.js';
import { enqueueReflectionJob, listReflectionJobs } from './reflection-queue.js';

const fixtureUrl = new URL('./claim-worker.fixture.ts', import.meta.url);

type WorkerResult = { claimantId: string; claimedIds: string[] };

type WorkerHandle = {
  ready: Promise<void>;
  result: Promise<WorkerResult>;
  go: () => void;
};

function spawnClaimant(filePath: string): WorkerHandle {
  const worker = new Worker(fixtureUrl, {
    workerData: { filePath },
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

  const result = new Promise<WorkerResult>((resolve, reject) => {
    worker.on('message', (msg: unknown) => {
      if (msg !== 'ready') {
        resolve(msg as WorkerResult);
      }
    });
    worker.on('error', reject);
  });

  return { ready, result, go: () => worker.postMessage('go') };
}

describe('two processes claiming against one substrate', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-claim-contention-'));
    dbPath = join(dir, 'aion.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('claims every job exactly once, with no lost jobs and no double-claims', async () => {
    const totalJobs = 400;
    const seedDb = openSqliteHandle({ filePath: dbPath });
    const seededIds = new Set<string>();
    for (let i = 0; i < totalJobs; i += 1) {
      seededIds.add(enqueueReflectionJob(seedDb, 'integrate', { i }));
    }
    seedDb.close();

    const a = spawnClaimant(dbPath);
    const b = spawnClaimant(dbPath);

    await Promise.all([a.ready, b.ready]);
    a.go();
    b.go();
    const [resultA, resultB] = await Promise.all([a.result, b.result]);

    // No SQLITE_BUSY escaped: both workers' claim loops ran to completion above, or
    // this test would have already rejected on the worker's 'error' event.
    expect(resultA.claimantId).not.toBe(resultB.claimantId);

    const claimedByA = new Set(resultA.claimedIds);
    const claimedByB = new Set(resultB.claimedIds);
    expect(claimedByA.size).toBe(resultA.claimedIds.length);
    expect(claimedByB.size).toBe(resultB.claimedIds.length);

    const overlap = [...claimedByA].filter((id) => claimedByB.has(id));
    expect(overlap).toEqual([]);

    const allClaimed = new Set([...claimedByA, ...claimedByB]);
    expect(allClaimed.size).toBe(totalJobs);
    expect(allClaimed).toEqual(seededIds);

    const db = openSqliteHandle({ filePath: dbPath });
    const remaining = listReflectionJobs(db);
    db.close();
    expect(remaining).toHaveLength(totalJobs);
    for (const job of remaining) {
      expect(job.claimedBy === resultA.claimantId || job.claimedBy === resultB.claimantId).toBe(true);
    }
  }, 30_000);
});
