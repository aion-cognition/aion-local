import { AnthropicBatchTransport, legalCustomId } from './anthropic-batches.js';
import { batchBoundUsd, batchHoldBound } from './batch-bounds.js';
import type {
  BatchClientOptions,
  BatchPoll,
  BatchResult,
  BatchTransport,
} from './batch-transport.js';
import { OpenAiBatchTransport } from './openai-batches.js';
import type { SpendingGuard } from './spending.js';
import type { GenerationProvider } from './types.js';
import type { Logger } from '../logging/logger.js';
import { appendApiCall, chargedApiUsd, unaccountedApiRequests } from '../sqlite/api-usage.js';
import {
  markBatchSubmitted,
  pendingBatchWork,
  outstandingBatchIds,
  returnBatchWork,
  settleBatchWork,
  settledBatchWorkKeys,
  submittedBatchWork,
  type BatchWorkItem,
} from '../sqlite/batch-work.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { settleGenerationSpend } from '../sqlite/spend-ledger.js';

/**
 * Batched generation, from the substrate's side.
 *
 * Background work that tolerates minutes to hours goes through the selected vendor's batch API at
 * half price. Cues and anything a caller is waiting on do not: they run on ordinary calls, because
 * a batch is not a latency budget. The vendor's wire is its transport (`batch-transport.ts`); what
 * follows is the same on either.
 *
 * Four rules hold this together, and each of them is a case that has gone wrong in systems like
 * this one:
 *
 * - Submission is not completion. The remote identity is written down, and nothing is counted as
 *   done until an answer for that identity has been applied.
 * - Results are consumed by identity. They come back unordered, keyed by `custom_id`, and an id
 *   this substrate does not recognize is discarded rather than guessed at.
 * - An answer is revalidated against the substrate before it is applied. Hours passed; the pair
 *   the judgment is about may have merged, been superseded, or been forgotten.
 * - Nothing here holds the publication guard. Applying is the handler's own publication, taken
 *   when the answer is in hand, and a remote job that runs for six hours holds nothing.
 */

/** What a surface does with its own answers. Registered by name; the work row carries the name. */
export type BatchWorkHandler = {
  readonly surface: string;
  /**
   * Whether the answer is still about the substrate it was asked about. False discards the
   * answer without applying it, which is a normal outcome rather than a failure: the question
   * stopped being the question while the remote was working.
   */
  isCurrent(db: SqliteHandle, revalidation: unknown): Promise<boolean> | boolean;
  /**
   * Applies one answer. Throws to leave the work owed; the adapter puts the row back and the
   * next submission re-asks. Its own publication, if it takes one, is taken in here.
   */
  apply(item: BatchWorkItem, answer: unknown): Promise<void>;
};

export type BatchAdapterDeps = {
  readonly db: SqliteHandle;
  /** The current substrate identity. Answers addressed to any other one are discarded. */
  readonly substrateId: string;
  /**
   * Whose work this pass handles. A submission sends only rows encoded for this provider, and
   * consumption reads only the jobs this provider holds, so a job is always read back through the
   * vendor that took it. Absent reads as Anthropic, the lane's one provider before OpenAI had one.
   */
  readonly provider?: GenerationProvider;
  /** That provider's key, and the fetch its transport sends through. */
  readonly client: BatchClientOptions;
  readonly handlers: readonly BatchWorkHandler[];
  readonly logger: Logger;
  /**
   * The day's spending backstop, consulted before a submission is sent and reconciled when its
   * answers come back. Absent leaves batch submission unbounded, which is what a caller composing
   * the adapter outside a configured substrate gets.
   */
  readonly spending?: SpendingGuard;
  readonly now?: () => Date;
};

/** How many work items one submission carries. Well under the API's own ceiling. */
export const DEFAULT_SUBMIT_LIMIT = 256;

export type SubmitReport = {
  readonly submitted: number;
  readonly batchId: string | undefined;
};

export type ConsumeReport = {
  readonly applied: number;
  /** Answers that arrived for work the substrate no longer wants applied. */
  readonly discarded: number;
  /** Answers returned to the queue: expired, cancelled, or a retryable error. */
  readonly returned: number;
  readonly failed: number;
  /** Answers whose id this substrate does not hold, which a reset is the ordinary cause of. */
  readonly unrecognized: number;
  /** Remote jobs still working. */
  readonly waiting: number;
};

export const EMPTY_CONSUME: ConsumeReport = {
  applied: 0,
  discarded: 0,
  returned: 0,
  failed: 0,
  unrecognized: 0,
  waiting: 0,
};

function clock(deps: BatchAdapterDeps): Date {
  return (deps.now ?? ((): Date => new Date()))();
}

function handlerFor(deps: BatchAdapterDeps, surface: string): BatchWorkHandler | undefined {
  return deps.handlers.find((handler) => handler.surface === surface);
}

/** The wire for this pass's provider. The key and the fetch are the caller's. */
function transportFor(deps: BatchAdapterDeps): BatchTransport {
  return deps.provider === 'openai'
    ? new OpenAiBatchTransport(deps.client)
    : new AnthropicBatchTransport(deps.client);
}

/**
 * Sends what is owed as one batch.
 *
 * The remote identity is written to every row of the batch in one transaction, immediately. A
 * crash before that write leaves the rows pending and costs a duplicate batch on the next pass,
 * which is the cheap direction: the expensive one is a batch nobody can find the answers to.
 *
 * A submission the day's ceiling cannot cover is not an error here. The work is background work
 * by construction, so it stays queued and the next pass under a fresh day's ceiling sends it,
 * which is the same answer a substrate with no key gives.
 */
export async function submitBatchWork(
  deps: BatchAdapterDeps,
  limit: number = DEFAULT_SUBMIT_LIMIT,
): Promise<SubmitReport> {
  const transport = transportFor(deps);
  // Clamped against the API's own ceiling, so a caller that passes a larger number gets a batch
  // the remote will accept rather than a rejection it has to read the docs to understand.
  const queued = pendingBatchWork(
    deps.db,
    deps.substrateId,
    Math.min(limit, transport.maxRequests),
    transport.provider,
  );
  const owed: BatchWorkItem[] = [];
  for (const item of queued) {
    if (legalCustomId(item.workKey)) {
      owed.push(item);
      continue;
    }
    // The remote refuses a whole submission over one id it cannot accept, so a producer that
    // wrote an id outside the contract loses its own row rather than everyone else's batch. It
    // is terminal because the next pass would build the same id from the same inputs.
    settleBatchWork(
      deps.db,
      item.workKey,
      'failed',
      'the work key is not a legal batch custom_id',
      clock(deps),
    );
    deps.logger.error(
      { workKey: item.workKey, surface: item.surface },
      'work key is outside what the batch API accepts; the row is failed rather than sent',
    );
  }
  if (owed.length === 0) {
    return { submitted: 0, batchId: undefined };
  }

  const held = deps.spending?.hold({
    surface: 'batch_submission',
    route: 'batch',
    now: clock(deps),
    ...batchHoldBound(transport, owed),
  });
  if (held !== undefined && 'refused' in held) {
    deps.logger.warn(
      { owed: owed.length, reason: held.refused.message },
      'batch submission held back by the daily generation ceiling; work stays queued',
    );
    return { submitted: 0, batchId: undefined };
  }
  const hold = held?.hold;

  let batchId: string;
  try {
    batchId = await transport.create(
      owed.map((item) => ({
        customId: item.workKey,
        params: item.request as Record<string, unknown>,
      })),
    );
  } catch (err) {
    // Nothing is marked: the work is still owed, and the next pass re-sends it. The hold stays,
    // because a submission whose answer was lost may be one the remote accepted, and a released
    // hold would hand the same headroom to the re-send while the first batch runs.
    hold?.settle(undefined, clock(deps));
    deps.logger.warn(
      { err, owed: owed.length, reservedUsd: hold?.reservedUsd },
      'batch submission answered nothing; work stays queued and its bound stays held',
    );
    return { submitted: 0, batchId: undefined };
  }

  markBatchSubmitted(
    deps.db,
    owed.map((item) => item.workKey),
    batchId,
    clock(deps),
    hold?.reservationId,
    transport.provider,
  );
  deps.logger.info(
    {
      batchId,
      provider: transport.provider,
      submitted: owed.length,
      reservedUsd: hold?.reservedUsd,
    },
    'batch submitted; the work is outstanding, not done',
  );
  return { submitted: owed.length, batchId };
}

/** Two passes' reports as one, for a caller that settles more than one provider's work. */
export function addConsumeReports(
  left: ConsumeReport,
  right: Partial<ConsumeReport>,
): ConsumeReport {
  return {
    applied: left.applied + (right.applied ?? 0),
    discarded: left.discarded + (right.discarded ?? 0),
    returned: left.returned + (right.returned ?? 0),
    failed: left.failed + (right.failed ?? 0),
    unrecognized: left.unrecognized + (right.unrecognized ?? 0),
    waiting: left.waiting + (right.waiting ?? 0),
  };
}

/**
 * Records what one answer cost, whatever becomes of the answer.
 *
 * Paid is paid. An answer this substrate discards as stale, one whose work row a reset took away,
 * and one that applies cleanly are the same charge, and a bill that counted only the useful ones
 * would report the batch lane as cheaper than it is by exactly the amount of the waste.
 *
 * The identity is the batch and the `custom_id` inside it, which is what the remote request
 * actually is. The response's own message id would do for a single reading; this one is stable
 * across every re-read of an ended batch, which is what stops a polling round from billing twice.
 */
function recordBatchUsage(
  deps: BatchAdapterDeps,
  transport: BatchTransport,
  batchId: string,
  result: Extract<BatchResult, { type: 'succeeded' }>,
  item: BatchWorkItem | undefined,
): void {
  const { model, usage } = transport.chargeOf(result.message, item?.request);
  const now = clock(deps);
  const submittedAt = item?.submittedAt === undefined ? undefined : Date.parse(item.submittedAt);
  try {
    const recorded = appendApiCall(deps.db, {
      occurredAt: now,
      model,
      surface: item?.surface ?? 'unlabeled',
      requestId: `${batchId}:${result.customId}`,
      pricingTier: 'batch',
      ...usage,
      // The remote's own turnaround, which is the only duration a batched request has: nothing
      // here waited on it.
      durationMs: submittedAt === undefined ? 0 : Math.max(0, now.getTime() - submittedAt),
      attempts: Math.max(1, item?.attempts ?? 1),
    });
    if (recorded && usage.usageError !== undefined) {
      deps.logger.error(
        { batchId, customId: result.customId },
        'batched answer carried no readable usage; its charge is unknown',
      );
    }
  } catch (err) {
    deps.logger.warn({ err, batchId, customId: result.customId }, 'batch usage write failed');
  }
}

/**
 * Applies one answer, or says why it did not.
 *
 * The order matters. The charge is recorded first, because it is owed whatever happens next. Then
 * the row is read by identity, the substrate is asked whether the question is still the question,
 * and only then is the answer applied. A handler that throws leaves the work owed rather than
 * swallowing an answer nobody can ask for again.
 */
async function consumeResult(
  deps: BatchAdapterDeps,
  transport: BatchTransport,
  batchId: string,
  result: BatchResult,
  owed: ReadonlyMap<string, BatchWorkItem>,
): Promise<Partial<ConsumeReport>> {
  const item = owed.get(result.customId);
  if (result.type === 'succeeded') {
    recordBatchUsage(deps, transport, batchId, result, item);
  }
  if (item === undefined) {
    // A result for an id this substrate does not hold: a batch from before a reset, an answer
    // already applied, or another substrate's work sharing a content-derived key.
    deps.logger.info({ customId: result.customId }, 'batch result belongs to no current work');
    return { unrecognized: 1 };
  }
  const now = clock(deps);

  if (result.type !== 'succeeded') {
    // Cancelled and expired work is still owed: the question was never answered. An error is
    // owed too, up to the handler's own limits, because a 429 inside a batch is not a verdict.
    returnBatchWork(deps.db, item.workKey, `${result.type}: ${result.detail}`, now);
    deps.logger.warn(
      { workKey: item.workKey, outcome: result.type },
      'batch result unusable; the work is owed again',
    );
    return { returned: 1 };
  }

  const handler = handlerFor(deps, item.surface);
  if (handler === undefined) {
    settleBatchWork(deps.db, item.workKey, 'failed', `no handler for surface ${item.surface}`, now);
    return { failed: 1 };
  }

  try {
    if (!(await handler.isCurrent(deps.db, item.revalidation))) {
      settleBatchWork(deps.db, item.workKey, 'discarded', 'the substrate moved', now);
      return { discarded: 1 };
    }
    await handler.apply(item, transport.answerOf(result.message));
    settleBatchWork(deps.db, item.workKey, 'applied', undefined, now);
    return { applied: 1 };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    returnBatchWork(deps.db, item.workKey, reason, now);
    deps.logger.warn({ err, workKey: item.workKey }, 'batch result not applied; work owed again');
    return { returned: 1 };
  }
}

/**
 * Reads every ended batch this substrate is waiting on and settles what came back.
 *
 * A batch still working is left alone and counted, so a caller can tell "nothing came back yet"
 * from "nothing is outstanding". Nothing here waits on a remote job.
 */
export async function consumeBatchWork(deps: BatchAdapterDeps): Promise<ConsumeReport> {
  const transport = transportFor(deps);
  let report = EMPTY_CONSUME;
  for (const batchId of outstandingBatchIds(deps.db, deps.substrateId, transport.provider)) {
    let poll: BatchPoll;
    try {
      poll = await transport.poll(batchId);
    } catch (err) {
      deps.logger.warn({ err, batchId }, 'batch status unreadable; it stays outstanding');
      report = addConsumeReports(report, { waiting: 1 });
      continue;
    }
    if (poll.state === 'working') {
      report = addConsumeReports(report, { waiting: 1 });
      continue;
    }

    let results: readonly BatchResult[];
    try {
      results =
        poll.state === 'ended'
          ? await transport.results(poll.sources)
          : refusedResults(deps, batchId, poll.detail);
    } catch (err) {
      deps.logger.warn({ err, batchId }, 'batch results unreadable; they stay outstanding');
      report = addConsumeReports(report, { waiting: 1 });
      continue;
    }

    const owed = new Map(submittedBatchWork(deps.db, batchId).map((item) => [item.workKey, item]));
    for (const result of results) {
      report = addConsumeReports(
        report,
        await consumeResult(deps, transport, batchId, result, owed),
      );
    }
    // A row the batch never answered for stays submitted and is picked up the next time this
    // batch is read, so a partial results file loses nothing.
    reconcileSubmission(deps, transport, batchId, owed);
    if (submittedBatchWork(deps.db, batchId).length === 0) {
      await releaseBatch(deps, transport, batchId);
    }
  }
  return report;
}

/**
 * Deletes what the vendor still stores for a job no row is waiting on. The job leaves the
 * outstanding list once its last row settles, so this runs once; a failure is logged and the
 * files stay behind rather than holding up the settlement already written.
 */
async function releaseBatch(
  deps: BatchAdapterDeps,
  transport: BatchTransport,
  batchId: string,
): Promise<void> {
  if (transport.release === undefined) {
    return;
  }
  try {
    await transport.release(batchId);
  } catch (err) {
    deps.logger.warn({ err, batchId }, 'settled batch files could not be deleted at the vendor');
  }
}

/**
 * A job the vendor refused whole ran none of its requests, so each row it carried reads as an
 * error and is owed again, the outcome a request refused on its own gets.
 */
function refusedResults(
  deps: BatchAdapterDeps,
  batchId: string,
  detail: string,
): readonly BatchResult[] {
  return submittedBatchWork(deps.db, batchId).map((item) => ({
    customId: item.workKey,
    type: 'errored',
    detail,
  }));
}

/**
 * Settles this batch's hold at what its answers were charged, plus a bound on the requests it has
 * not accounted for yet.
 *
 * A results file can be partial, and a row it never mentioned is still at the remote with work to
 * do. Settling the whole hold to the charges on the books would read those requests as free and
 * hand their headroom to the next submission, so the unresolved rows keep a reservation of their
 * own until an answer prices them.
 *
 * Both halves are recomputed rather than accumulated: the charges come from the books by request
 * identity, and the retained part is re-derived from the rows still outstanding. A batch read
 * again, in this process or a later one, settles to the same number instead of a growing one.
 *
 * A charge that cannot be priced leaves the hold untouched at its bound, which is the only honest
 * reading of money nobody can size. A charge with no usage row at all is the same money: the hold
 * settles at its bound as an unresolved obligation rather than at the total of whatever rows did
 * land.
 */
function reconcileSubmission(
  deps: BatchAdapterDeps,
  transport: BatchTransport,
  batchId: string,
  owed: ReadonlyMap<string, BatchWorkItem>,
): void {
  const reservationId = [...owed.values()].find(
    (item) => item.reservationId !== undefined,
  )?.reservationId;
  if (reservationId === undefined || deps.spending === undefined) {
    return;
  }
  // Every request this batch has settled was answered, so every one of them is a charge. A
  // settled row with no bill under its own request identity is a charge that was never written
  // down, and the sum of the rows that were written cannot see it. The hold stays at its bound
  // and the day names it as unresolved, which is what an obligation nobody can size costs. It
  // outlives the work: the row is terminal and no answer is coming back to price it.
  const unaccounted = unaccountedApiRequests(
    deps.db,
    settledBatchWorkKeys(deps.db, batchId).map((workKey) => `${batchId}:${workKey}`),
  );
  if (unaccounted.length > 0) {
    settleGenerationSpend(deps.db, reservationId, undefined, clock(deps));
    deps.logger.error(
      { batchId, unaccounted: unaccounted.length },
      'answers of this batch carry no usage record; its bound is held as an unaccounted charge',
    );
    return;
  }
  const charged = chargedApiUsd(deps.db, batchId);
  if (charged === undefined) {
    return;
  }
  const unresolved = submittedBatchWork(deps.db, batchId);
  const retained = unresolved.length === 0 ? 0 : batchBoundUsd(transport, unresolved);
  settleGenerationSpend(deps.db, reservationId, charged + retained, clock(deps));
}
