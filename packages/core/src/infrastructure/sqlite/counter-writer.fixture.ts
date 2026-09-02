// Standalone worker script, not compiled and not vitest-collected: counter-concurrency.test.ts
// starts two of these as real worker_threads so their increments of one meta row race for real,
// which a single thread issuing calls one after another cannot produce. It keeps the project's
// .js-specifier convention because the test loads ts-specifier-hook.fixture.ts ahead of it, and
// that hook maps the specifiers back to the .ts sources native node type stripping runs.
import { parentPort, workerData } from 'node:worker_threads';

import { openSqliteHandle } from './database.js';
import { nextIntrospectionCycle } from './introspection-counters.js';
import { recordPackMethodMetrics } from './method-counters.js';
import { recordRecallOutcome } from './recall-cadence.js';
import { recordCueOutcome } from './recall-samples.js';
import { recordReinforcementFlush } from './reinforcement-queue.js';

type WorkerInput = {
  filePath: string;
  rows: number;
};

if (parentPort === null) {
  throw new Error('counter-writer.fixture.ts must run as a worker_thread');
}

const input = workerData as WorkerInput;
const port = parentPort;

// Rendezvous with the parent: both writers report ready, then wait for one 'go' so their
// opens land as close together as the runtime allows.
port.once('message', () => {
  const db = openSqliteHandle({ filePath: input.filePath });
  for (let i = 0; i < input.rows; i += 1) {
    recordPackMethodMetrics(db, ['vector'], {
      vector: { sole: 1, shared: 0, rrfContribution: 2 },
    });
    recordRecallOutcome(db, { empty: true });
    recordCueOutcome(db, true);
    recordReinforcementFlush(db, {
      signalsApplied: 1,
      pairsApplied: 1,
      edgesUpdated: 1,
      at: '2026-09-02T00:00:00.000Z',
    });
    nextIntrospectionCycle(db);
  }
  db.close();
  port.postMessage({ done: input.rows });
});

port.postMessage('ready');
