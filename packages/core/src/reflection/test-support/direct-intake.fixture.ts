import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import type { MergePublisher } from '../../evidence/application/merge-recovery.js';
import { GraphTransaction } from '../../infrastructure/graph/connection.js';
import type { Embedder } from '../../infrastructure/providers/types.js';
import {
  PUBLICATION_KINDS,
  type PublicationOutcome,
  type PublicationHandler,
} from '../../infrastructure/publication/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { reflectionCompletionPublication } from '../application/completion-publication.js';
import { intakePublication } from '../application/intake-publication.js';
import type { IntakePublisher } from '../application/intake-transport.js';
import { claimMergePublication } from '../application/merge-publication.js';
import { attachSourceVectors, drainPendingVectors } from '../application/vectors.js';
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

/**
 * The same, for a claim merge. The batch's recovery branch is the subject of its own cases, so
 * this publisher holds no pending slot and recovers nothing: what it supplies is the operation.
 */
export function directMergePublisher(
  driver: Driver,
  db: SqliteHandle,
  clock: () => Date = () => new Date(),
): MergePublisher {
  const publisher = directPublisher(claimMergePublication, driver, db, clock);
  return {
    publish: (request): Promise<PublicationOutcome> => publisher.publish(request),
    hasPending: (): boolean => false,
    recover: (): Promise<PublicationOutcome | undefined> => Promise.resolve(undefined),
  };
}

/** The same, for the settlement a finished reflection run publishes. */
export function directCompletionPublisher(
  driver: Driver,
  db: SqliteHandle,
  clock: () => Date = () => new Date(),
): CompletionPublisher {
  return directPublisher(reflectionCompletionPublication, driver, db, clock);
}

type DirectPublisher = {
  publish(request: {
    readonly operationId: string;
    readonly payload: unknown;
  }): Promise<PublicationOutcome>;
};

function directPublisher(
  operation: PublicationHandler,
  driver: Driver,
  db: SqliteHandle,
  clock: () => Date,
): IntakePublisher & CompletionPublisher & DirectPublisher {
  // The coverage registry is what an acceptance checks its epoch against, and coordinator
  // initialization is what mints it on a real substrate. A test substrate takes the preparing
  // record, which is the state a real one is in before coverage is activated.
  ensureCoverageRegistry(db);
  ensurePairing(db);
  return {
    async publish(request): Promise<PublicationOutcome> {
      const now = clock();
      const sequence = String(Date.now());
      const session = driver.session();
      try {
        return await session.executeWrite(async (tx) => {
          const graph = new GraphTransaction(tx);
          const context = {
            operationId: request.operationId,
            sequence,
            graph,
            db,
            now,
            // This driver stands in for a coordinator composed with everything, which is what
            // the handler under test would meet in the service.
            installedKinds: [...PUBLICATION_KINDS],
          };
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

/**
 * The pairing a real substrate takes at coordinator initialization. An operation that projects a
 * trust hint needs the substrate identity the hint is read back against, and a fixture without
 * one would make that operation fail for a reason the substrate it stands in for does not have.
 */
function ensurePairing(db: SqliteHandle): void {
  const held = db.prepare('SELECT 1 FROM publication_control LIMIT 1').get();
  if (held !== undefined) {
    return;
  }
  db.prepare(
    `INSERT INTO publication_control
       (substrate_id, bootstrap_state, protocol_version, last_ack_sequence)
     VALUES (?, 'initialized', 1, 0)`,
  ).run(randomUUID());
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

/**
 * Runs the embedding an acceptance queued, the way the reflection worker runs it.
 *
 * Intake returns before anything embeds, so a fixture that goes on to assert on vector search
 * has to run the queued work itself. Draining the whole pending set rather than one source's
 * row is deliberate: a fixture pushing a corpus wants every one of them vectored, and that is
 * the same operation the worker's startup drain performs.
 */
export function drainAcceptedVectors(
  driver: Driver,
  provider: Embedder,
  batchSize = 100,
): Promise<number> {
  return drainPendingVectors({ driver, provider, logger: { warn: () => undefined } }, batchSize);
}

/**
 * The same, narrowed to one accepted source.
 *
 * A fixture that also writes nodes by hand needs this one: the whole-backlog drain would embed
 * a node the fixture deliberately left without a vector, which is the state several of them are
 * built to measure.
 */
export function drainSourceVectors(
  driver: Driver,
  provider: Embedder,
  sourceId: string,
): Promise<number> {
  return attachSourceVectors({ driver, provider, logger: { warn: () => undefined } }, sourceId);
}
