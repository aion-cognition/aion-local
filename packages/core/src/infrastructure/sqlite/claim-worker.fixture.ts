// Standalone script, not compiled and not vitest-collected: claim-two-process.test.ts
// forks two of these as real child processes, each opening its own better-sqlite3
// connection, so their claims contend through the POSIX file locks that gate real
// cross-process access rather than through one process's own connection mutex.
// Outside the tsc/vitest module graph it resolves siblings by their real .ts filename
// instead of the project's usual .js-specifier convention, which native node does not
// map back to the source file.
import { ReflectionQueueClaimant } from './claim.ts';
import { openSqliteHandle } from './database.ts';

type WorkerResult = { claimantId: string; claimedIds: string[] };

const filePath = process.argv[2];
if (filePath === undefined) {
  throw new Error('claim-worker.fixture.ts needs the substrate path as its first argument');
}

const send = process.send?.bind(process);
if (send === undefined) {
  throw new Error('claim-worker.fixture.ts must run as a forked child process');
}

// Rendezvous with the parent: both children report ready, then wait for one 'go' so
// their claim loops start as close together as the runtime allows.
process.once('message', () => {
  const db = openSqliteHandle({ filePath });
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
  send(result);
});

send('ready');
