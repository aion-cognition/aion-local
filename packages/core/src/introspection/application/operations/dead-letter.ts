import {
  countDeadLetterAttention,
  deadLetterSeenKey,
  listExhaustedJobs,
  relaneDeadLetterJob,
} from '../../../infrastructure/sqlite/dead-letter-queue.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

export const DEAD_LETTER_OPERATION = 'dead_letter';

/** Mirrors `maintenance.deadLetterBatchSize`'s own default; see `defaults.ts` for why. */
const DEFAULT_DEAD_LETTER_BATCH_SIZE = 50;

/**
 * An exhausted queue row (`attempts >= workerMaxAttempts`, still unclaimed) is otherwise
 * permanent: the claim path skips it forever. This operation gives each such row exactly
 * one more cycle, re-laned to bulk so it never jumps ahead of an agent's own turn, with
 * attempts reset so the claim path will take it again.
 *
 * A row that fails that one retry and lands back here a second time is left alone. Retrying
 * forever would hide a job that genuinely cannot succeed behind a queue that always looks
 * like it is working; instead the row's ops-ledger marker turns it into
 * `queue.deadLetterAttentionCount`, which surfaces in the health snapshot and never resets
 * itself. Nothing is ever dropped: a row this operation cannot fix stays queued, visible,
 * and unclaimed until a person looks at it.
 */
export function deadLetterRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.queue.exhausted / DEFAULT_DEAD_LETTER_BATCH_SIZE);
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
      // The listing already excludes rows that spent their one retry, so every row in the batch
      // is one this pass can act on. The count of the rest comes from the whole table, not from
      // a batch they no longer occupy.
      const exhausted = listExhaustedJobs(ctx.db, maxAttempts, batchSize);
      const stillNeedsAttention = countDeadLetterAttention(ctx.db, maxAttempts);

      let relaned = 0;
      for (const job of exhausted) {
        if (ctx.signal.aborted) {
          break;
        }
        if (relaneDeadLetterJob(ctx.db, job.id)) {
          markLedgerApplied(ctx.db, deadLetterSeenKey(job.id), { jobType: job.jobType });
          relaned += 1;
        }
      }

      return Promise.resolve({
        status: relaned === 0 ? 'noop' : 'applied',
        itemsProcessed: exhausted.length,
        itemsAffected: relaned,
        detail:
          `${String(relaned)} relaned to bulk for one retry, ` +
          `${String(stillNeedsAttention)} already retried and still exhausted`,
      });
    },
  };
}
