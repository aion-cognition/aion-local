import { Neo4jError } from 'neo4j-driver';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { inWriteTransaction } from './connection.js';
import { readManagedWriteObservations } from './managed-write-observations.js';
import {
  startFamilyProbe,
  stopFamilyProbe,
  type FamilyProbe,
} from './test-support/entity-unmerge-family.fixture.js';

let probe: FamilyProbe;
beforeAll(async () => {
  probe = await startFamilyProbe('aion-retry-counter-control-');
}, 300_000);
afterAll(async () => {
  await stopFamilyProbe(probe);
});

it('counts the actual managed-driver replay and leaves only the committed attempt', async () => {
  let attempts = 0;
  const before = readManagedWriteObservations(probe.watched);
  const value = await inWriteTransaction(probe.watched, async (tx) => {
    attempts += 1;
    const rows = await tx.run(
      `MERGE (n:AionNode {id: $id})
       SET n.review_count = coalesce(n.review_count, 0) + 1
       RETURN n.review_count AS count`,
      { id: 'retry-counter-control' },
      (row) => row.count,
    );
    if (attempts === 1) {
      throw new Neo4jError(
        'scripted retryable callback failure',
        'Neo.TransientError.Transaction.DeadlockDetected',
        '50N42',
        'scripted test failure',
      );
    }
    return rows[0];
  });
  const after = readManagedWriteObservations(probe.watched);
  expect(value).toBe(1);
  expect(attempts).toBe(2);
  expect(after.callbackAttempts - before.callbackAttempts).toBe(2);
  expect(after.callbackReplays - before.callbackReplays).toBe(1);
  expect(after.replaysByClass.deadlock - before.replaysByClass.deadlock).toBe(1);
  expect(after.callbackFailures - before.callbackFailures).toBe(1);
  expect(after.callerFulfilments - before.callerFulfilments).toBe(1);
  expect(after.callerRejections - before.callerRejections).toBe(0);
  expect(probe.failures).toHaveLength(1);
  console.log(JSON.stringify({ attempts, committedCount: value, before, after }));
}, 60_000);
