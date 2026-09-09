import type { PublicationOutcome } from '../../../infrastructure/publication/types.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import type { OwedSignalCursor } from '../../../infrastructure/sqlite/source-lifecycle.js';
import {
  confirmationSignalState,
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
 * Bounded on both axes. One batch of nominations per run, and the delivery key is fixed per owed
 * key over a statement set that does not change, so a repeat offers the same delivery and a
 * target still unknown simply stays owed. Nothing polls: the operation is scored like every
 * other repair and reports a noop when the records owe nothing.
 */

export const CONFIRMATION_SIGNAL_COMPLETION_OPERATION = 'confirmation_signal_completion';

/**
 * Standing relevance, like `merge_decision_reconcile`: no health snapshot counts an owed signal,
 * so this reaches the urgency threshold on waiting time rather than on a measured backlog.
 *
 * The limitation that comes with it, stated rather than argued away: a growing backlog does not
 * raise this operation's priority, so how long a given obligation waits depends on how often the
 * loop selects it and not on how much is owed. Whether that wants a gauge is a question for a
 * measured backlog and a measured completed-key rate, neither of which exists yet.
 */
export const CONFIRMATION_SIGNAL_COMPLETION_STANDING_RELEVANCE = 0.15;

/**
 * How many owed keys one run NOMINATES. Not how many it finishes: a nomination that stays owed
 * is still a nomination, and the run reports the two separately.
 */
const BATCH = 25;

/**
 * How far one run walks before it stops, in pages.
 *
 * The batch alone is not forward progress. Twenty-five obligations that can never resolve sit at
 * the front of a stable enumeration order forever, and a run that always starts at the front
 * never reaches the twenty-sixth however many times it runs. So the position the last run
 * stopped at is durable, and the next one resumes strictly past it, wrapping to the start when
 * the enumeration ends. Over runs every owed key is therefore visited.
 *
 * Paging discharges nothing. An obligation is settled by its own settlement and by nothing else;
 * a cursor moving past a key says only that this run looked at it.
 */
const MAX_PAGES = 8;

/** Where the last run stopped. One row, rewritten each run, naming a key and nothing else. */
const CURSOR_KEY = 'confirmation_signal_completion:cursor';

function readCursor(db: SqliteHandle): OwedSignalCursor | undefined {
  const summary = getLedgerEntry(db, CURSOR_KEY)?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { sourceId, referenceVersion } = summary as {
    sourceId?: unknown;
    referenceVersion?: unknown;
  };
  if (typeof sourceId !== 'string' || typeof referenceVersion !== 'number') {
    return undefined;
  }
  return { sourceId, referenceVersion };
}

/** Absent clears it, which is what the end of the enumeration means. */
function writeCursor(db: SqliteHandle, cursor: OwedSignalCursor | undefined): void {
  markLedgerApplied(db, CURSOR_KEY, cursor === undefined ? {} : { ...cursor });
}

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
 * Every statement one owed key covers, as a delivery.
 *
 * The WHOLE set travels, not the part still waiting. A delivery is identified by the set it
 * accepts, so offering a shrinking subset under a key fixed per obligation makes the second pass
 * a different delivery under the first one's name, and one key cannot stand for two outcomes.
 * Which of them resolves is asked again under the guard on every pass, which is where that
 * question belongs.
 *
 * Two clocks and they are not the same fact. `occurredAt` travels only where the original caller
 * stated one, because a repair may not put a claim in the record that nobody made.
 * `resolvedOccurredAt` is the moment the first acceptance already settled on, so the edge this
 * publication writes carries the confirmation's own moment rather than the repair's.
 */
function deliveryFor(signal: OwedConfirmationSignal, at: Date): Record<string, unknown> {
  return {
    sourceId: signal.sourceId,
    supersedes: [],
    derivedFrom: [],
    confirmations: signal.covered.map((covered) => ({
      target: covered.targetId,
      by: covered.by,
      evidence: covered.evidence,
      resolvedOccurredAt: covered.occurredAt,
      ...(covered.statedOccurredAt === undefined ? {} : { occurredAt: covered.statedOccurredAt }),
    })),
    deliveryKey: confirmationSignalDeliveryKey(signal),
    observedAt: at.toISOString(),
  };
}

function noop(detail: string): OperationOutcome {
  return { status: 'noop', itemsProcessed: 0, itemsAffected: 0, detail };
}

/**
 * One key's attempt. The publication is where the guarded lookup and the settle happen; this
 * only asks for it and reads what the records say afterwards.
 *
 * A publication that refuses, defers or throws leaves the key exactly where it was: owed, and
 * offered again on a later run. The obligation is durable, so nothing is lost, and a repair that
 * failed the whole tick would take the rest of the batch and every operation after it with one
 * busy coordinator.
 */
async function attempt(
  ctx: OperationContext,
  references: ReferencePublisher,
  signal: OwedConfirmationSignal,
): Promise<boolean> {
  try {
    await references.publish({
      kind: 'stated_references',
      operationId: confirmationSignalOperationId(signal, ctx.now),
      payload: deliveryFor(signal, ctx.now),
    });
  } catch (err) {
    ctx.logger.warn(
      { err, sourceId: signal.sourceId, referenceVersion: signal.referenceVersion },
      'confirmation signal completion could not publish; the signal stays owed',
    );
    return false;
  }
  // Read what the obligation says, not what the publication returned. An acknowledged
  // publication whose targets are still unaccounted for has settled nothing, and reporting its
  // status as a completion would count work nobody did.
  const settled =
    confirmationSignalState(ctx.db, signal.sourceId, signal.referenceVersion) === 'completed';
  if (!settled) {
    ctx.logger.debug(
      { sourceId: signal.sourceId, referenceVersion: signal.referenceVersion },
      'confirmation signal completion published and the signal is still owed',
    );
  }
  return settled;
}

async function runCompletion(ctx: OperationContext): Promise<OperationOutcome> {
  const { references } = ctx;
  if (references === undefined) {
    return noop('no publisher composed to settle a confirmation signal through; nothing asked');
  }
  let cursor = readCursor(ctx.db);
  let wrapped = cursor === undefined;
  let nominated = 0;
  let settled = 0;
  for (let page = 0; page < MAX_PAGES && nominated < BATCH; page += 1) {
    const owed = owedConfirmationSignals(ctx.db, BATCH - nominated, cursor);
    if (owed.length === 0) {
      // The end of the enumeration. Start again from the front once, so a run that resumed near
      // the tail still spends its batch, and stop if it has already been round.
      if (wrapped) {
        cursor = undefined;
        break;
      }
      wrapped = true;
      cursor = undefined;
      continue;
    }
    for (const signal of owed) {
      if (ctx.signal.aborted) {
        break;
      }
      nominated += 1;
      if (await attempt(ctx, references, signal)) {
        settled += 1;
      }
      cursor = { sourceId: signal.sourceId, referenceVersion: signal.referenceVersion };
    }
    if (ctx.signal.aborted) {
      break;
    }
  }
  writeCursor(ctx.db, cursor);
  if (nominated === 0) {
    return noop('no confirmation signal is owed');
  }
  return {
    status: settled === 0 ? 'noop' : 'applied',
    itemsProcessed: nominated,
    itemsAffected: settled,
    detail:
      `${String(settled)} of ${String(nominated)} nominated confirmation signal(s) settled; ` +
      `${String(nominated - settled)} still owed`,
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
