// Standalone worker script, not compiled and not vitest-collected: claim-two-process.test.ts
// starts two of these as real worker_threads, each opening its own better-sqlite3
// connection, so their claims race for real against one substrate file. Outside the
// tsc/vitest module graph it resolves siblings by their real .ts filename instead of
// the project's usual .js-specifier convention, which native node does not map back
// to the source file.
import { parentPort, workerData } from 'node:worker_threads';
import { ReflectionQueueClaimant } from './claim.ts';
import { openSqliteHandle } from './database.ts';

type WorkerInput = { filePath: string };
type WorkerResult = { claimantId: string; claimedIds: string[] };

if (parentPort === null) {
  throw new Error('claim-worker.fixture.ts must run as a worker_thread');
}

const input = workerData as WorkerInput;
const port = parentPort;

// Rendezvous with the parent: both workers report ready, then wait for one 'go' so
// their claim loops start as close together as the runtime allows.
port.once('message', () => {
  const db = openSqliteHandle({ filePath: input.filePath });
  const claimant = new ReflectionQueueClaimant();
  const claimedIds: string[] = [];

  // A claim returning undefined means, atomically, no unclaimed row existed at that
  // instant; nothing re-enqueues during the test, so that is the drain signal.
  let job = claimant.claimNext(db);
  while (job !== undefined) {
    claimedIds.push(job.id);
    job = claimant.claimNext(db);
  }

  db.close();
  const result: WorkerResult = { claimantId: claimant.id, claimedIds };
  port.postMessage(result);
});

port.postMessage('ready');
