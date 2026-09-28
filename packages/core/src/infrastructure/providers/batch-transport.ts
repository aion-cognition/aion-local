import type { UsageCounters } from './anthropic-usage.js';
import type { CacheWriteClass } from './request-blocks.js';
import type { GenerationProvider } from './types.js';

/**
 * What the batch lane needs from one vendor's batch API, and nothing about how the lane uses it.
 *
 * The lifecycle (what is owed, who holds it, what an answer is charged, whether it still applies)
 * is the adapter's, and it is the same on every vendor. What differs is the wire: how a set of
 * requests becomes one remote job, how that job says it has ended, where its answers are read
 * from, and how one answer carries its text and its usage. Each vendor answers those four in its
 * own file, and a row settles through the vendor it was encoded for.
 */

export type BatchClientOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
};

export type BatchRequest = {
  /** The work key. Unique within one batch, and what the result is matched back by. */
  readonly customId: string;
  /** One request body in the vendor's own shape, minus the batching wrapper. */
  readonly params: Record<string, unknown>;
};

/** One request's outcome. `succeeded` carries the vendor's response body; the rest carry a reason. */
export type BatchResult =
  | { readonly customId: string; readonly type: 'succeeded'; readonly message: unknown }
  | {
      readonly customId: string;
      readonly type: 'errored' | 'canceled' | 'expired';
      readonly detail: string;
    };

/**
 * Where one remote job stands.
 *
 * `working` is anything short of an end, however the vendor names it. `ended` means every answer
 * the job will ever give is readable from `sources`. `refused` means the vendor ended the job
 * without running any request in it, so every row it carried is owed again.
 */
export type BatchPoll =
  | { readonly state: 'working' }
  | {
      readonly state: 'ended';
      readonly sources: readonly string[];
      /**
       * Every request the job carried is accounted for in `sources`, so a row they never name got
       * no answer and never will. Absent where a read can be partial and a later one completes it.
       */
      readonly final?: boolean;
    }
  | { readonly state: 'refused'; readonly detail: string };

/**
 * The vendor answered a submission without creating a job. Nothing is running and nothing will
 * bill, so the adapter releases the submission's hold rather than keeping it against a job that
 * might exist, which is what a submission whose answer was lost has to do.
 */
export class BatchNotCreatedError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'BatchNotCreatedError';
  }
}

/**
 * An answer the vendor would give again to the same request, such as a refusal. The row fails
 * rather than being sent again, the way the synchronous route does not retry one.
 */
export class BatchAnswerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchAnswerRefusedError';
  }
}

/** What one stored request can be billed at, read off its own body. */
export type BatchRequestBound = CacheWriteClass & {
  readonly model: string | undefined;
  /** The output ceiling the body names, which the vendor enforces rather than estimates. */
  readonly outputTokens: number;
};

export type BatchTransport = {
  readonly provider: GenerationProvider;
  /** The vendor's own ceiling on requests in one job. */
  readonly maxRequests: number;
  bound(request: unknown): BatchRequestBound;
  /** Sends one job and answers with the remote identity, which is the only way back to it. */
  create(requests: readonly BatchRequest[]): Promise<string>;
  poll(batchId: string): Promise<BatchPoll>;
  /** Every answer an ended job returned, in whatever order the vendor wrote them. */
  results(sources: readonly string[]): Promise<readonly BatchResult[]>;
  /** The JSON value one succeeded response carries. Throws where it carries none. */
  answerOf(message: unknown): unknown;
  /**
   * What one succeeded response was charged. `request` is the stored body it answers, absent for
   * an answer no current work holds.
   */
  chargeOf(
    message: unknown,
    request: unknown,
  ): { readonly model: string; readonly usage: UsageCounters };
  /**
   * Deletes what the vendor still stores for a job once every row it carried has settled. Absent
   * where the vendor expires that on its own.
   */
  release?(batchId: string): Promise<void>;
};
