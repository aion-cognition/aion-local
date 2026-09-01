// Standalone worker script, not compiled and not vitest-collected: concurrent-writers.test.ts
// starts two of these as real worker_threads so their opens of and writes to one SQLite file
// race for real, which a single thread issuing calls one after another cannot simulate.
// Outside the tsc/vitest module graph it resolves siblings by their real .ts filename
// instead of the project's usual .js-specifier convention, which native node does not
// map back to the source file.
import { parentPort, workerData } from 'node:worker_threads';

import { openSqliteHandle, type SqliteHandle } from './database.ts';
import { recordEntityMergeDecision } from './entity-merge-decisions.ts';
import { enqueueReflectionJob } from './reflection-queue.ts';

type WorkerInput = {
  filePath: string;
  label: string;
  rows: number;
  /** Absent means the reflection queue, whose rows carry a key of their own per writer. */
  table?: 'entity_merge_decisions';
};

if (parentPort === null) {
  throw new Error('concurrent-writer.fixture.ts must run as a worker_thread');
}

const input = workerData as WorkerInput;
const port = parentPort;

/** One row per iteration, keyed by this writer's label, so the two writers never collide. */
function enqueueJobs(db: SqliteHandle, rows: number, label: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    ids.push(enqueueReflectionJob(db, 'test-job', { label, i }));
  }
  return ids;
}

/**
 * Both writers record the same group under the same cascade version, so every iteration is
 * one insert and one conflict across two connections. The label rides in `reasons`, which is
 * a column the conflict branch overwrites, so it cannot change the key either writer computes.
 */
function recordDecisions(db: SqliteHandle, rows: number, label: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    ids.push(
      recordEntityMergeDecision(db, {
        canonicalId: `entity-canonical-${i}`,
        memberIds: [`entity-member-${i}`],
        tier: 'tier0',
        reasons: [label],
        signals: [],
        cascadeVersion: 'cascade-1',
      }),
    );
  }
  return ids;
}

// Rendezvous with the parent: both writers report ready, then wait for one 'go' so
// their opens land as close together as the runtime allows.
port.once('message', () => {
  const db = openSqliteHandle({ filePath: input.filePath });
  const done =
    input.table === 'entity_merge_decisions'
      ? recordDecisions(db, input.rows, input.label)
      : enqueueJobs(db, input.rows, input.label);
  db.close();
  port.postMessage({ done });
});

port.postMessage('ready');
