import type { Provider } from '../../../infrastructure/providers/types.js';
import { runningBuild } from '../../../infrastructure/running-build.js';
import {
  hasUntriedConditions,
  listExhaustedJobs,
  listRetriedExhaustedJobs,
  readRetryConditions,
  readRetryEnvironment,
  recordDeadLetterRetry,
  relaneDeadLetterJob,
  type ExhaustedJob,
  type RetryConditions,
} from '../../../infrastructure/sqlite/dead-letter-queue.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

export const DEAD_LETTER_OPERATION = 'dead_letter';

/** Mirrors `maintenance.deadLetterBatchSize`'s own default; see `defaults.ts` for why. */
const DEFAULT_DEAD_LETTER_BATCH_SIZE = 50;

/**
 * An exhausted queue row (`attempts >= workerMaxAttempts`, still unclaimed) is otherwise
 * permanent: the claim path skips it forever. This operation gives such a row another cycle,
 * re-laned to bulk so it never jumps ahead of an agent's own turn, with attempts reset so the
 * claim path takes it again and the worker woken to take it. Stage results the earlier cycles
 * applied stay applied, because the per-stage ledger keys a retry skips are untouched.
 *
 * The first exhaustion always gets a cycle. After that a row gets one only when its conditions
 * (the build, the readiness policy, the generation route, and its source's evidence) differ from
 * every cycle it already failed under, and each cycle records the conditions it ran under. A
 * corrected failure or changed evidence is reconsidered on the next pass with nobody asking for
 * it. A failure that repeats under unchanged conditions is not retried in a loop: the row stays
 * queued with its last error, is counted in `queue.deadLetterAttentionCount`, and waits for
 * something that could change its outcome. Nothing is ever dropped.
 */
export function deadLetterRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.queue.exhausted / DEFAULT_DEAD_LETTER_BATCH_SIZE);
}

/** A test fake carries no route; it stays one fixed route rather than a changing one. */
function generationRouteOf(provider: Provider): string {
  const { route } = provider;
  if (route === undefined) {
    return 'unrouted';
  }
  return `${route.provider}:${route.model ?? 'default'}`;
}

/**
 * Tells the worker a row is claimable again, through the hook intake wakes it with. The worker
 * claims only when woken, so without this a re-laned row waits for the next capture. The row is
 * durable either way, and a wakeup that fails costs it only that wait.
 */
function wakeWorker(ctx: OperationContext, jobId: string): void {
  const listener = ctx.intake?.onJobEnqueued;
  if (listener === undefined) {
    return;
  }
  const failed = (err: unknown): void => {
    ctx.logger.warn({ err, jobId }, 'dead_letter could not wake the reflection worker');
  };
  try {
    const result = listener(jobId);
    if (result instanceof Promise) {
      result.catch(failed);
    }
  } catch (err) {
    failed(err);
  }
}

/** Re-lanes one row and records the conditions its cycle runs under, when it actually moved. */
function grantRetry(
  ctx: OperationContext,
  job: ExhaustedJob,
  conditions: RetryConditions,
): boolean {
  if (!relaneDeadLetterJob(ctx.db, job.id)) {
    return false;
  }
  recordDeadLetterRetry(ctx.db, job, conditions, ctx.now);
  wakeWorker(ctx, job.id);
  return true;
}

export function deadLetterOperation(): IntrospectionOperation {
  return {
    name: DEAD_LETTER_OPERATION,
    bucket: 'hour',
    relevance: deadLetterRelevance,
    measure: (health) => health.queue.exhausted,
    improves: 'lower',
    // Every step here is a synchronous SQLite call; `run` still returns a promise because
    // `IntrospectionOperation.run` is one operation's contract shared with graph-backed ones.
    run: (ctx): Promise<OperationOutcome> => {
      const maxAttempts = ctx.config.operational.workerMaxAttempts;
      const batchSize = ctx.config.maintenance.deadLetterBatchSize;
      const environment = readRetryEnvironment(ctx.db, {
        build: runningBuild(),
        generationRoute: generationRouteOf(ctx.provider),
      });

      // Rows never retried come first: the listing excludes rows that already had a cycle, so
      // every row in it is one this pass can act on.
      const fresh = listExhaustedJobs(ctx.db, maxAttempts, batchSize);
      let relaned = 0;
      for (const job of fresh) {
        if (ctx.signal.aborted) {
          break;
        }
        if (grantRetry(ctx, job, readRetryConditions(ctx.db, environment, job.sourceId))) {
          relaned += 1;
        }
      }

      // Then every row that failed again, each read against the conditions it already failed
      // under. The ones past this run's bound keep their changed conditions for the next pass.
      const retried = listRetriedExhaustedJobs(ctx.db, maxAttempts);
      let reconsidered = 0;
      let unchanged = 0;
      let deferred = 0;
      for (const job of retried) {
        if (ctx.signal.aborted) {
          break;
        }
        const current = readRetryConditions(ctx.db, environment, job.sourceId);
        if (!hasUntriedConditions(job.retries, current)) {
          unchanged += 1;
          continue;
        }
        if (relaned + reconsidered >= batchSize) {
          deferred += 1;
          continue;
        }
        if (grantRetry(ctx, job, current)) {
          reconsidered += 1;
        }
      }

      const affected = relaned + reconsidered;
      const later = deferred === 0 ? '' : ` (${String(deferred)} more next run)`;
      return Promise.resolve({
        status: affected === 0 ? 'noop' : 'applied',
        itemsProcessed: fresh.length + retried.length,
        itemsAffected: affected,
        detail:
          `${String(relaned)} relaned to bulk for a first retry, ` +
          `${String(reconsidered)} reconsidered under changed conditions${later}, ` +
          `${String(unchanged)} exhausted again under conditions already tried`,
      });
    },
  };
}
