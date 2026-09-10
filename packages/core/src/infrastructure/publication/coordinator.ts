import type { Driver } from 'neo4j-driver';

import {
  PublicationInvariantError,
  PublicationPendingError,
  PublicationUnavailable,
  publicationFailure,
} from './errors.js';
import { initializePublication } from './initialize.js';
import { canonicalJson, parseJson } from './json.js';
import { needsGraphCompletion, validatePublicationEffects } from './operation.js';
import { parseAffectedScopes, parsePublicationPreconditions } from './preconditions.js';
import { verifyPublicationState } from './protocol.js';
import {
  PublicationReadBarrier,
  type ReadCompletion,
  type SynchronousResult,
} from './read-barrier.js';
import { PublicationTransactions, type LockedPublication as Locked } from './transaction.js';
import {
  PUBLICATION_KINDS,
  GRAPH_COMPLETION_EFFECT,
  PUBLICATION_PROTOCOL_VERSION,
  type CheckpointResult,
  type PublicationBoundary,
  type PublicationBoundaryEvent,
  type PublicationCheckpoint,
  type PublicationContext,
  type PublicationHandler,
  type PublicationKind,
  type PublicationMetric,
  type PublicationOutcome,
  type PublicationPlan,
} from './types.js';
import { writePublicationGuardReceipt } from '../graph/publication-receipt.js';
import type { Logger } from '../logging/logger.js';
import { readCurrentCoverageContract } from '../sqlite/coverage-contract.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { publicationWrite } from '../sqlite/publication-bounded.js';
import {
  acknowledgeCoordinatorRecord,
  coordinatorControl,
  clearUncommittedPublicationResult,
  discardCoordinatorRecord,
  prepareCoordinatorRecord,
  publicationBindingDigest,
  publicationOutcome,
  publicationRecord,
  publicationResult,
  savePublicationResult,
  storedPlan,
  type PublicationRecord,
} from '../sqlite/publication-coordinator-store.js';

export type PublicationCoordinatorOptions = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly handlers: readonly PublicationHandler[];
  readonly logger: Pick<Logger, 'warn' | 'error'>;
  readonly now?: () => Date;
  readonly transactionTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly intentByteLimit?: number;
  readonly observe?: (metric: PublicationMetric) => void;
  /** Fault injection runs only outside SQLite transactions; absent in service composition. */
  readonly boundary?: (event: PublicationBoundaryEvent) => void | Promise<void>;
};

export type PublicationRequest = {
  readonly kind: PublicationKind;
  readonly operationId: string;
  readonly payload: unknown;
};

/** One surviving receipt serializes publications; domain handlers own only their data and effects. */
export class PublicationCoordinator {
  readonly #options: PublicationCoordinatorOptions;
  readonly #handlers = new Map<PublicationKind, PublicationHandler>();
  readonly #now: () => Date;
  readonly #transactionTimeoutMs: number;
  readonly #readTimeoutMs: number;
  readonly #intentByteLimit: number;
  readonly #transactions: PublicationTransactions;
  readonly #reads: PublicationReadBarrier;
  #initialized = false;

  constructor(options: PublicationCoordinatorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#transactionTimeoutMs = options.transactionTimeoutMs ?? 5000;
    this.#readTimeoutMs = options.readTimeoutMs ?? 1000;
    this.#intentByteLimit = options.intentByteLimit ?? 4 * 1024 * 1024;
    for (const value of [this.#transactionTimeoutMs, this.#readTimeoutMs, this.#intentByteLimit]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('publication bounds must be positive safe integers');
      }
    }
    this.#transactions = new PublicationTransactions({
      driver: options.driver,
      db: options.db,
      logger: options.logger,
      now: this.#now,
      timeoutMs: this.#transactionTimeoutMs,
      ...(options.observe === undefined ? {} : { observe: options.observe }),
    });
    this.#reads = new PublicationReadBarrier({
      driver: options.driver,
      db: options.db,
      transactions: this.#transactions,
      now: this.#now,
      timeoutMs: this.#readTimeoutMs,
    });
    for (const handler of options.handlers) {
      if (!PUBLICATION_KINDS.includes(handler.kind) || this.#handlers.has(handler.kind)) {
        throw new Error('publication kinds must be known and registered once');
      }
      this.#handlers.set(handler.kind, handler);
    }
  }

  /** Bootstrap is additive and never replaces an initialized missing or foreign receipt. */
  async initialize(): Promise<void> {
    this.#outsideSqlite();
    await initializePublication(this.#options.driver, this.#options.db, this.#readTimeoutMs);
    this.#initialized = true;
  }

  async publish(request: PublicationRequest): Promise<PublicationOutcome> {
    this.#ready();
    this.#outsideSqlite();
    const handler = this.#handler(request.kind);
    if (request.operationId.trim() === '') {
      throw new Error('publication operation identity is required');
    }
    const payloadJson = canonicalJson(handler.decodePayload(request.payload));
    this.#withinBytes(payloadJson);
    // At most one preceding operation can exist. A third slot is never a retry policy.
    for (let pass = 0; pass < 2; pass += 1) {
      const result = await this.#transactions.run('publish', async (lock) => {
        const state = verifyPublicationState(this.#options.db, lock.receipt);
        const previous = publicationRecord(this.#options.db, request.operationId);
        if (previous !== undefined) {
          this.#sameRequest(previous, request, payloadJson);
          if (previous.state !== 'prepared') {
            return publicationOutcome(previous);
          }
        }
        if (state.pending !== undefined) {
          const recovered = await this.#recoverLocked(lock, state.pending, state.committed);
          return state.pending.operationId === request.operationId ? recovered : undefined;
        }
        const context = this.#context(lock, request.operationId, null);
        const supplied = await handler.prepare(context, parseJson(payloadJson));
        const plan = this.#plan(handler, supplied);
        const check = await this.#check(context, handler, plan);
        const digest = publicationBindingDigest(request.kind, payloadJson, plan);
        this.#withinBytes(canonicalJson({ payload: parseJson(payloadJson), plan }));
        const record = publicationWrite(this.#options.db, () => {
          const saved = prepareCoordinatorRecord(
            this.#options.db,
            {
              operationId: request.operationId,
              kind: request.kind,
              payloadJson,
              digest,
              plan,
              now: context.now,
            },
            check.status === 'valid',
          );
          if (check.status !== 'valid') {
            return discardCoordinatorRecord(this.#options.db, saved, check.status, check.reason);
          }
          this.#sync(
            handler.prepareSqlite(
              {
                db: this.#options.db,
                operationId: saved.operationId,
                sequence: saved.sequence,
              },
              plan,
            ),
          );
          return saved;
        });
        if (record.state !== 'prepared') {
          return publicationOutcome(record);
        }
        await this.#boundary('prepared', record);
        return this.#apply(lock, record, handler, storedPlan(record, handler));
      });
      if (result !== undefined) {
        return result;
      }
    }
    throw new PublicationUnavailable('recovery_did_not_release_slot', request.operationId);
  }

  /** Startup and every new writer call this same bounded recovery path. */
  async recover(): Promise<PublicationOutcome | undefined> {
    this.#ready();
    this.#outsideSqlite();
    return this.#transactions.run('recover', async (lock) => {
      const state = verifyPublicationState(this.#options.db, lock.receipt);
      if (state.pending === undefined) {
        return undefined;
      }
      return this.#recoverLocked(lock, state.pending, state.committed);
    });
  }

  hasPending(): boolean {
    this.#ready();
    return coordinatorControl(this.#options.db).pendingOperationId !== null;
  }

  /**
   * What the substrate durably records about one operation, without acquiring the guard or
   * recovering anything. A caller that lost its own commit response needs this to tell an
   * operation another actor already settled from one that never landed.
   *
   * A prepared record is a normal state, not a violation: the operation is durable and its
   * outcome is not decided yet, so it answers nothing. A record that claims acknowledgment
   * without the clocks that make one is still a loud invariant.
   */
  outcomeOf(operationId: string): PublicationOutcome | undefined {
    this.#ready();
    const record = publicationRecord(this.#options.db, operationId);
    if (record === undefined || record.state === 'prepared') {
      return undefined;
    }
    return publicationOutcome(record);
  }

  /** No lock acquisition or recovery: pending publications are disclosed immediately. */
  async checkpoint(): Promise<CheckpointResult> {
    if (!this.#initialized) {
      return { status: 'unavailable', reason: 'coordinator_not_initialized' };
    }
    return this.#reads.checkpoint();
  }

  /** Caller validation reads the graph; completion persists SQLite effects only, then releases the graph lock by rollback. */
  async completeRead<T>(
    checkpoint: PublicationCheckpoint,
    validate: (context: PublicationContext) => Promise<boolean>,
    complete: (db: SqliteHandle) => SynchronousResult<T>,
  ): Promise<ReadCompletion<T>> {
    this.#ready();
    this.#outsideSqlite();
    return this.#reads.complete(checkpoint, validate, complete);
  }

  async #recoverLocked(
    lock: Locked,
    record: PublicationRecord,
    committed: boolean,
  ): Promise<PublicationOutcome> {
    const handler = this.#handler(record.kind);
    const plan = storedPlan(record, handler);
    if (committed) {
      if (needsGraphCompletion(plan) && handler.finishGraph !== undefined) {
        await handler.finishGraph(
          this.#context(lock, record.operationId, record.sequence),
          plan,
          publicationResult(record),
        );
        await lock.commit();
      }
      return this.#ack(record, handler, plan);
    }
    const check = await this.#check(
      this.#context(lock, record.operationId, record.sequence),
      handler,
      plan,
    );
    if (check.status !== 'valid') {
      const discarded = publicationWrite(this.#options.db, () => {
        this.#sync(
          handler.discardSqlite(
            {
              db: this.#options.db,
              operationId: record.operationId,
              sequence: record.sequence,
            },
            plan,
            check.reason,
          ),
        );
        return discardCoordinatorRecord(this.#options.db, record, check.status, check.reason);
      });
      return publicationOutcome(discarded);
    }
    publicationWrite(this.#options.db, () => {
      clearUncommittedPublicationResult(this.#options.db, record, lock.receipt.sequence);
    });
    return this.#apply(lock, record, handler, plan);
  }

  async #apply(
    lock: Locked,
    record: PublicationRecord,
    handler: PublicationHandler,
    plan: PublicationPlan,
  ): Promise<PublicationOutcome> {
    try {
      const result = handler.decodeResult(
        await handler.applyGraph(this.#context(lock, record.operationId, record.sequence), plan),
      );
      this.#withinBytes(canonicalJson(result));
      publicationWrite(this.#options.db, () => {
        savePublicationResult(this.#options.db, record, result);
      });
      await this.#boundary('graph_result_saved', record);
      const saved = publicationRecord(this.#options.db, record.operationId);
      if (saved?.resultDigest == null) {
        throw new PublicationInvariantError('publication_result_missing', record.operationId);
      }
      await writePublicationGuardReceipt(lock.graph, {
        substrateId: lock.receipt.substrateId,
        protocolVersion: PUBLICATION_PROTOCOL_VERSION,
        operationId: record.operationId,
        sequence: record.sequence,
        intentDigest: record.payloadDigest,
        resultDigest: saved.resultDigest,
      });
      await lock.commit();
      await this.#boundary('graph_committed', record);
      if (needsGraphCompletion(plan)) {
        // A fresh guard transaction owns any necessary post-commit materialization.
        return await this.#transactions.run('recover', async (next) => {
          const state = verifyPublicationState(this.#options.db, next.receipt);
          const current = publicationRecord(this.#options.db, record.operationId);
          if (current?.state === 'acknowledged') {
            return publicationOutcome(current);
          }
          if (state.pending?.operationId !== record.operationId || !state.committed) {
            throw new PublicationInvariantError(
              'publication_completion_receipt_missing',
              record.operationId,
            );
          }
          return this.#recoverLocked(next, state.pending, true);
        });
      }
      return await this.#ack(saved, handler, plan);
    } catch (err) {
      if (err instanceof PublicationUnavailable) {
        throw err;
      }
      throw lock.commitAttempted
        ? new PublicationPendingError(record.operationId, err)
        : publicationFailure(err, record.operationId);
    }
  }

  async #ack(
    record: PublicationRecord,
    handler: PublicationHandler,
    plan: PublicationPlan,
  ): Promise<PublicationOutcome> {
    await this.#boundary('before_ack', record);
    const current = publicationRecord(this.#options.db, record.operationId);
    if (current?.state === 'acknowledged') {
      return publicationOutcome(current);
    }
    // The matching commit was verified under a guard, or returned by this attempt's commit.
    if (current?.resultDigest !== record.resultDigest) {
      throw new PublicationInvariantError('publication_ack_result_changed', record.operationId);
    }
    const acknowledged = publicationWrite(this.#options.db, () =>
      acknowledgeCoordinatorRecord(this.#options.db, current, plan, handler, this.#now()),
    );
    await this.#boundary('acknowledged', acknowledged);
    return publicationOutcome(acknowledged);
  }

  #handler(kind: string): PublicationHandler {
    const handler = this.#handlers.get(kind as PublicationKind);
    if (handler === undefined) {
      throw new PublicationUnavailable('operation_kind_unavailable');
    }
    return handler;
  }

  async #check(context: PublicationContext, handler: PublicationHandler, plan: PublicationPlan) {
    const coverage = readCurrentCoverageContract(this.#options.db);
    if (coverage === undefined) {
      throw new PublicationInvariantError('coverage_registry_missing', context.operationId);
    }
    if (coverage.epoch !== plan.expected.coverageEpoch) {
      return { status: 'deferred', reason: 'coverage_epoch_changed' } as const;
    }
    return handler.check(context, plan);
  }

  #sameRequest(record: PublicationRecord, request: PublicationRequest, payloadJson: string): void {
    if (record.kind !== request.kind || record.payloadJson !== payloadJson) {
      throw new PublicationInvariantError('operation_identity_reused', request.operationId);
    }
    storedPlan(record, this.#handler(record.kind));
  }

  #plan(handler: PublicationHandler, plan: PublicationPlan): PublicationPlan {
    if (plan.effects.some((effect) => effect.kind === GRAPH_COMPLETION_EFFECT)) {
      throw new Error('graph completion effect is owned by the coordinator');
    }
    const normalized = {
      data: handler.decodeData(plan.data),
      expected: parsePublicationPreconditions(plan.expected),
      scopes: parseAffectedScopes(plan.scopes),
      effects: plan.effects.map((effect) => ({ ...effect })),
    };
    if (handler.finishGraph !== undefined) {
      normalized.effects.push({ kind: GRAPH_COMPLETION_EFFECT, detail: {} });
    }
    if (
      normalized.effects.some((effect) => !/^[a-z][a-z0-9_:-]*$/.test(effect.kind)) ||
      new Set(normalized.effects.map((effect) => effect.kind)).size !== normalized.effects.length
    ) {
      throw new Error('publication scopes and effect identities must be valid and unique');
    }
    canonicalJson(normalized);
    validatePublicationEffects(handler, normalized);
    return normalized;
  }

  #context(lock: Locked, operationId: string, sequence: string | null): PublicationContext {
    return { operationId, sequence, graph: lock.graph, db: this.#options.db, now: this.#now() };
  }

  #withinBytes(text: string): void {
    if (Buffer.byteLength(text) > this.#intentByteLimit) {
      throw new PublicationUnavailable('publication_byte_limit');
    }
  }

  #sync(value: unknown): void {
    if (value !== undefined) {
      throw new PublicationInvariantError('async_sqlite_effect');
    }
  }

  #outsideSqlite(): void {
    if (this.#options.db.inTransaction) {
      throw new PublicationInvariantError('enclosing_sqlite_transaction');
    }
  }

  #ready(): void {
    if (!this.#initialized) {
      throw new PublicationUnavailable('coordinator_not_initialized');
    }
  }

  async #boundary(boundary: PublicationBoundary, record: PublicationRecord): Promise<void> {
    this.#outsideSqlite();
    await this.#options.boundary?.({
      boundary,
      operationId: record.operationId,
      sequence: record.sequence,
    });
    this.#outsideSqlite();
  }
}
