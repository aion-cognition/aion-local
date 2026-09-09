import type { PublicationOutcome } from '../../../infrastructure/publication/types.js';
import {
  owedConfirmationSignals,
  type OwedConfirmationSignal,
} from '../../../reflection/application/confirmation-signals.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * The completion owner for a confirmation nobody could file yet.
 *
 * A caller may confirm a memory this substrate has not taken, and the statement is accepted
 * against the identity it named. Its usage-stream signal is a different obligation and it stays
 * owed while the target is an id nothing accounts for. Nothing in the acceptance path can finish
 * it: that publication is already acknowledged, so the recovery loop has nothing to recover, and
 * the acknowledgment is SQLite-only, so it cannot ask the graph whether the target has arrived.
 *
 * This is the one thing that asks. It reads the owed obligations, and for each one publishes the
 * statements that key still waits on as a stated-references delivery of its own. The publication
 * does the work the acknowledgment may not: its prepare holds the guard and asks the graph which
 * of those ids are projected now, its acceptance records the answer, and its acknowledgment
 * settles the signal. Nothing here writes an event or a completion directly.
 *
 * Bounded on both axes. One batch per run, and the delivery key is fixed per owed key, so a run
 * that repeats accepts no second version of the same statements and a target that is still
 * unknown simply stays owed. Nothing polls: the operation is scored like every other repair and
 * reports a noop when the records owe nothing.
 */

export const CONFIRMATION_SIGNAL_COMPLETION_OPERATION = 'confirmation_signal_completion';

/**
 * Standing relevance, like `merge_decision_reconcile`: an owed signal has no gauge in the health
 * snapshot and should not get one, because counting them costs the same read the repair itself
 * takes. It reaches the urgency threshold on waiting time instead.
 */
export const CONFIRMATION_SIGNAL_COMPLETION_STANDING_RELEVANCE = 0.15;

/** How many owed keys one run finishes. A backlog drains over runs rather than in one. */
const BATCH = 25;

/**
 * Where a repair publishes. The coordinator under a third name, beside the two it already
 * answers to: an operation composed without one declines rather than writing the settlement
 * outside the guard that fences it.
 */
export type ReferencePublisher = {
  publish(request: {
    readonly kind: 'stated_references';
    readonly operationId: string;
    readonly payload: unknown;
  }): Promise<PublicationOutcome>;
};

/** One delivery per owed key, so a repeated run accepts nothing new and settles the same key. */
export function confirmationSignalDeliveryKey(signal: OwedConfirmationSignal): string {
  return `confirmation-signal-repair:${signal.sourceId}:${String(signal.referenceVersion)}`;
}

/** The operation identity one attempt takes, so its receipt is its own. */
export function confirmationSignalOperationId(signal: OwedConfirmationSignal, at: Date): string {
  return `confirmation-signal-completion:${signal.sourceId}:${String(signal.referenceVersion)}:${at.toISOString()}`;
}

/**
 * The statements one owed key is still waiting on, as a delivery.
 *
 * The moment travels only where the original caller stated one. A repair inventing an occurrence
 * time would put a claim in the record that nobody made, and the event's own clock comes from the
 * first accepted version either way.
 */
function deliveryFor(signal: OwedConfirmationSignal, at: Date): Record<string, unknown> {
  return {
    sourceId: signal.sourceId,
    supersedes: [],
    derivedFrom: [],
    confirmations: signal.pending.map((pending) => ({
      target: pending.targetId,
      by: pending.by,
      evidence: pending.evidence,
      ...(pending.statedOccurredAt === undefined ? {} : { occurredAt: pending.statedOccurredAt }),
    })),
    deliveryKey: confirmationSignalDeliveryKey(signal),
    observedAt: at.toISOString(),
  };
}

function noop(detail: string): OperationOutcome {
  return { status: 'noop', itemsProcessed: 0, itemsAffected: 0, detail };
}

async function runCompletion(ctx: OperationContext): Promise<OperationOutcome> {
  const { references } = ctx;
  if (references === undefined) {
    return noop('no publisher composed to settle a confirmation signal through; nothing asked');
  }
  const owed = owedConfirmationSignals(ctx.db, BATCH);
  if (owed.length === 0) {
    return noop('no confirmation signal is owed');
  }
  let settled = 0;
  let deferred = 0;
  for (const signal of owed) {
    if (ctx.signal.aborted) {
      break;
    }
    // A publication that refuses, defers or fails outright leaves this key exactly where it was:
    // owed, and offered again on the next run. The obligation is durable, so nothing is lost by
    // stopping here, and a repair that failed the whole tick would take the rest of the batch
    // and every operation after it down with one busy coordinator.
    try {
      const outcome = await references.publish({
        kind: 'stated_references',
        operationId: confirmationSignalOperationId(signal, ctx.now),
        payload: deliveryFor(signal, ctx.now),
      });
      if (outcome.status === 'acknowledged') {
        settled += 1;
        continue;
      }
      deferred += 1;
      ctx.logger.debug(
        { sourceId: signal.sourceId, referenceVersion: signal.referenceVersion, outcome },
        'confirmation signal completion left owed',
      );
    } catch (err) {
      deferred += 1;
      ctx.logger.warn(
        { err, sourceId: signal.sourceId, referenceVersion: signal.referenceVersion },
        'confirmation signal completion could not publish; the signal stays owed',
      );
    }
  }
  return {
    status: settled === 0 ? 'noop' : 'applied',
    itemsProcessed: owed.length,
    itemsAffected: settled,
    detail:
      `${String(settled)} of ${String(owed.length)} owed confirmation signal(s) settled; ` +
      `${String(deferred)} left owed`,
  };
}

export function confirmationSignalCompletionOperation(): IntrospectionOperation {
  return {
    name: CONFIRMATION_SIGNAL_COMPLETION_OPERATION,
    bucket: 'hour',
    relevance: () => CONFIRMATION_SIGNAL_COMPLETION_STANDING_RELEVANCE,
    run: runCompletion,
  };
}
