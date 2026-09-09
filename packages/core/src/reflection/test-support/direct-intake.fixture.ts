import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import { GraphTransaction } from '../../infrastructure/graph/connection.js';
import type {
  PublicationOutcome,
  PublicationHandler,
} from '../../infrastructure/publication/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { reflectionCompletionPublication } from '../application/completion-publication.js';
import { intakePublication } from '../application/intake-publication.js';
import type { IntakePublisher } from '../application/intake-transport.js';
import type { CompletionPublisher } from '../application/worker.js';

/**
 * The intake operation driven straight through its own phases, for a test that needs an accepted
 * source and not the publication protocol.
 *
 * It runs the real operation: the same prepare, check, graph write, durable prepare and
 * acknowledgment the coordinator runs, in the same order. What it does not run is the protocol
 * around them, so nothing here holds the guard, journals an intent, writes a receipt or recovers
 * anything, and a test using it proves nothing about crash behaviour. The protocol has its own
 * native battery against real stores; this is for the tests whose subject is what an acceptance
 * leaves behind.
 *
 * A driver that cannot begin an explicit transaction gets its managed session instead, which is
 * what a fake driver in a unit test supplies.
 */
export function directIntakePublisher(
  driver: Driver,
  db: SqliteHandle,
  clock: () => Date = () => new Date(),
): IntakePublisher {
  return directPublisher(intakePublication, driver, db, clock);
}

/** The same, for the settlement a finished reflection run publishes. */
export function directCompletionPublisher(
  driver: Driver,
  db: SqliteHandle,
  clock: () => Date = () => new Date(),
): CompletionPublisher {
  return directPublisher(reflectionCompletionPublication, driver, db, clock);
}

function directPublisher(
  operation: PublicationHandler,
  driver: Driver,
  db: SqliteHandle,
  clock: () => Date,
): IntakePublisher & CompletionPublisher {
  // The coverage registry is what an acceptance checks its epoch against, and coordinator
  // initialization is what mints it on a real substrate. A test substrate takes the preparing
  // record, which is the state a real one is in before coverage is activated.
  ensureCoverageRegistry(db);
  return {
    async publish(request): Promise<PublicationOutcome> {
      const now = clock();
      const sequence = String(Date.now());
      const session = driver.session();
      try {
        return await session.executeWrite(async (tx) => {
          const graph = new GraphTransaction(tx);
          const context = { operationId: request.operationId, sequence, graph, db, now };
          const plan = await operation.prepare(context, operation.decodePayload(request.payload));
          const check = await operation.check(context, plan);
          if (check.status !== 'valid') {
            db.transaction(() => {
              operation.discardSqlite(
                { operationId: request.operationId, sequence, db },
                plan,
                check.reason,
              );
            }).immediate();
            return {
              status: check.status,
              operationId: request.operationId,
              sequence,
              reason: check.reason,
            };
          }
          db.transaction(() => {
            operation.prepareSqlite({ operationId: request.operationId, sequence, db }, plan);
          }).immediate();
          const result = await operation.applyGraph(context, plan);
          db.transaction(() => {
            operation.acknowledgeSqlite(
              {
                operationId: request.operationId,
                sequence,
                db,
                knownFrom: now.toISOString(),
                observedAckAt: now.toISOString(),
                clockClamped: false,
              },
              plan,
              result,
            );
          }).immediate();
          return {
            status: 'acknowledged',
            operationId: request.operationId,
            sequence,
            result,
            knownFrom: now.toISOString(),
            observedAckAt: now.toISOString(),
            clockClamped: false,
          };
        });
      } finally {
        await session.close();
      }
    },
  };
}

function ensureCoverageRegistry(db: SqliteHandle): void {
  const held = db.prepare('SELECT 1 FROM coverage_contract LIMIT 1').get();
  if (held !== undefined) {
    return;
  }
  db.prepare(
    `INSERT INTO coverage_contract (contract_version, epoch, field_policy_version, state)
     VALUES (1, ?, 1, 'preparing')`,
  ).run(randomUUID());
}
