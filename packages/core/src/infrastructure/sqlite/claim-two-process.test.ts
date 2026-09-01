import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteHandle } from './database.js';
import { enqueueReflectionJob, listReflectionJobs } from './reflection-queue.js';

const fixturePath = fileURLToPath(new URL('./claim-worker.fixture.ts', import.meta.url));
/** Resolves the `.js` specifiers the sources under the fixture are written against. */
const specifierHook = fileURLToPath(new URL('./ts-specifier-hook.fixture.ts', import.meta.url));

type WorkerResult = { claimantId: string; claimedIds: string[] };

type WorkerHandle = {
  ready: Promise<void>;
  result: Promise<WorkerResult>;
  go: () => void;
};

/**
 * Real child processes, not worker threads. Within one process SQLite serializes
 * connections through its own in-process mutex, which is not the mechanism that gates the
 * deployment this claim path exists for: the CLI container claiming beside the service, or
 * a restarted service meeting the previous instance's rows. Only separate processes
 * contend through the POSIX file locks that do.
 */
function spawnClaimant(filePath: string): WorkerHandle {
  const child = fork(fixturePath, [filePath], {
    execArgv: ['--experimental-strip-types', '--import', specifierHook],
  });

  const failed = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`claimant exited with code ${String(code)}`));
      }
    });
  });

  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', (msg: unknown) => {
      if (msg === 'ready') {
        resolve();
      } else {
        reject(new Error(`unexpected message before ready: ${String(msg)}`));
      }
    });
  });

  const result = new Promise<WorkerResult>((resolve) => {
    child.on('message', (msg: unknown) => {
      if (msg !== 'ready') {
        resolve(msg as WorkerResult);
      }
    });
  });

  return {
    ready: Promise.race([ready, failed]),
    result: Promise.race([result, failed]),
    go: () => child.send('go'),
  };
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

    // No SQLITE_BUSY escaped: both claim loops ran to completion above, or the child
    // would have died on the throw and this test would already have rejected.
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
      expect(job.claimedBy === resultA.claimantId || job.claimedBy === resultB.claimantId).toBe(
        true,
      );
    }
  }, 30_000);
});
