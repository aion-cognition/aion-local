import type { Driver } from 'neo4j-driver';

import type { ReflectionRun, ReflectionRunOptions } from './orchestrator.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Embedder } from '../../infrastructure/providers/types.js';
import type { PublicationOutcome } from '../../infrastructure/publication/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/** What the reflection worker is given and what it reports, apart from how it runs. */

/** `ReflectionOrchestrator` satisfies this; the worker never constructs the pipeline it drives. */
export type ReflectionRunner = {
  run(episodeId: string, options?: ReflectionRunOptions): Promise<ReflectionRun>;
};

/** The one thing the worker asks of the coordinator: publish this run's settlement. */
export type CompletionPublisher = {
  publish(request: {
    readonly kind: 'reflection_completion';
    readonly operationId: string;
    readonly payload: unknown;
  }): Promise<PublicationOutcome>;
};

export type ReflectionWorkerDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Embedder;
  readonly runner: ReflectionRunner;
  readonly logger: Logger;
  /** Where a finished run settles what it owed. There is no second way to complete a job. */
  readonly publications: CompletionPublisher;
  /**
   * What the source-index drain reads a source through. Required: a composition without one
   * would leave the `source_index` rows an acceptance writes unclaimed forever, and every
   * source behind them eviction-pinned. A worker that cannot index says so at compile time.
   */
  readonly resolver: EvidenceResolver;
};

export type ReflectionWorkerOptions = {
  readonly workerCount?: number;
  readonly staleTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryCapMs?: number;
  readonly maxAttempts?: number;
  readonly breakerThreshold?: number;
  readonly breakerCooldownMs?: number;
  readonly vectorBatchSize?: number;
  /**
   * Read once per job and handed to the run as its clock. The wall clock in live operation,
   * which is what keeps a stage's elapsed-time decision measuring real elapsed time; a test
   * or a replay supplies its own.
   */
  readonly clock?: () => Date;
};

export type ReflectionDrain = {
  /** Claims a dead process left behind, returned to the pool. */
  readonly reclaimed: number;
  /** `:Memory` nodes an earlier inference outage left without a content vector. */
  readonly vectored: number;
  /** Jobs this drain ran, whatever each of them made of its episode. */
  readonly ran: number;
  /** Search documents the index drain wrote for the sources whose rows it claimed. */
  readonly indexed: number;
};

export const EMPTY_DRAIN: ReflectionDrain = { reclaimed: 0, vectored: 0, ran: 0, indexed: 0 };
