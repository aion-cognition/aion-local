// Standalone worker script, not compiled and not vitest-collected: concurrent-writers.test.ts
// starts two of these as real worker_threads so their first opens of a fresh SQLite file
// race for real, which a single thread issuing calls one after another cannot simulate.
// Outside the tsc/vitest module graph it resolves siblings by their real .ts filename
// instead of the project's usual .js-specifier convention, which native node does not
// map back to the source file.
import { parentPort, workerData } from 'node:worker_threads';

import { openSqliteHandle } from './database.ts';
import { enqueueReflectionJob } from './reflection-queue.ts';

type WorkerInput = { filePath: string; label: string; rows: number };

if (parentPort === null) {
  throw new Error('concurrent-writer.fixture.ts must run as a worker_thread');
}

const input = workerData as WorkerInput;
const port = parentPort;

// Rendezvous with the parent: both writers report ready, then wait for one 'go' so
// their opens land as close together as the runtime allows.
port.once('message', () => {
  const db = openSqliteHandle({ filePath: input.filePath });
  for (let i = 0; i < input.rows; i += 1) {
    enqueueReflectionJob(db, 'test-job', { label: input.label, i });
  }
  db.close();
  port.postMessage('done');
});

port.postMessage('ready');
