import type { FeedbackReport, RecallFeedback } from '@aion/protocol';

import type { ConfirmationWrite } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  appendMemoryConfirmedEvent,
  appendSelfReportEvent,
  type SelfReportKind,
} from '../../infrastructure/sqlite/usage-events.js';
import { redactPayload } from '../../redaction/deep-walk.js';
import { hashContent } from '../domain/content.js';

/**
 * What a caller states about memories it was served, on its way into the usage stream.
 *
 * Three statements, three rows, and they never collapse into one. That a pack arrived is
 * something only the caller can say. That the caller acted on a memory is something only the
 * caller can say, and it says it about itself, so it is filed as a self-report however the
 * reporter is named. That somebody confirmed a memory is a different claim again: it is
 * attributable because it cites a reference, and it reaches the stream from the confirmation
 * record the reflection call already wrote rather than from a field of its own.
 *
 * Nothing here decides anything. No weight moves for a report, no stage waits on one, and an
 * absent report is not a claim that the pack went unread.
 */

export type FeedbackDeps = {
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

/** Each stated list and the kind its rows land under. */
const REPORT_KINDS: readonly (readonly ['received' | 'used', SelfReportKind])[] = [
  ['received', 'delivery_acknowledged'],
  ['used', 'memory_used'],
];

/**
 * The reports with their free text redacted, ids untouched, for the reason stated references
 * are: `reporter` and `evidence` are arbitrary caller text the substrate stores and reads back,
 * and an id is a reference to a node the substrate already holds, so rewriting one would point
 * it at nothing.
 */
function redactReports(
  deps: FeedbackDeps,
  reports: readonly FeedbackReport[],
  entropyThreshold: number,
): FeedbackReport[] {
  const redacted = redactPayload(
    reports.map((entry) => ({ reporter: entry.reporter, evidence: entry.evidence ?? '' })),
    entropyThreshold,
  );
  if (redacted.matches.length > 0) {
    deps.logger.warn(
      { matches: redacted.matches, count: redacted.matches.length },
      'redacted secrets from stated feedback',
    );
  }
  return reports.map((entry, index) => ({
    ...entry,
    reporter: redacted.value[index]?.reporter ?? entry.reporter,
    ...(entry.evidence === undefined
      ? {}
      : { evidence: redacted.value[index]?.evidence ?? entry.evidence }),
  }));
}

export function redactFeedback(
  deps: FeedbackDeps,
  feedback: RecallFeedback | undefined,
  entropyThreshold: number,
): RecallFeedback | undefined {
  if (feedback === undefined) {
    return undefined;
  }
  return {
    ...(feedback.received === undefined
      ? {}
      : { received: redactReports(deps, feedback.received, entropyThreshold) }),
    ...(feedback.used === undefined
      ? {}
      : { used: redactReports(deps, feedback.used, entropyThreshold) }),
  };
}

/**
 * The digest a repeat is recognised by, built from what the caller stated and never from when
 * the statement arrived. A client retrying a push resends the same words under a fresh wall
 * clock, and a second row for one statement would read as a second report.
 *
 * The occurrence is whatever the caller says it is. A report that names an `occurred_at` is
 * identified by that time, so using a memory at noon and again at one are two occurrences and
 * either one retried stays one row. A report that names no time has no occurrence identity of
 * its own, so it takes the experience it rode in on: the same experience re-pushed resolves to
 * the same episode and folds, a later experience saying the same thing is a second report. Two
 * reports of one stated occurrence stay one row however many experiences carry them, since the
 * caller named the moment rather than the telling.
 */
function selfReportKey(
  kind: SelfReportKind,
  input: RecallFeedbackInput,
  report: FeedbackReport,
): string {
  return `feedback:${kind}:${hashContent({
    sessionId: input.sessionId,
    memories: report.memories,
    reporter: report.reporter,
    evidence: report.evidence ?? null,
    occurredAt: report.occurred_at ?? null,
    episodeId: report.occurred_at === undefined ? input.episodeId : null,
  })}`;
}

export type RecallFeedbackInput = {
  readonly feedback: RecallFeedback | undefined;
  readonly sessionId: string;
  /** The experience the reports rode in on, which is what identifies one that named no time. */
  readonly episodeId: string;
  /** The stamp a report that named no time of its own is dated to. */
  readonly now: Date;
};

/**
 * Every report the call stated, recorded once each.
 *
 * Failure is logged and swallowed, which is the opposite of what the confirmation path below
 * does and for one reason: nothing acknowledges these. No ledger records that they landed and no
 * completion runs behind them, so a lost row leaves no false claim that it was written, and
 * failing an experience that is already durable would cost the caller more than the row is
 * worth.
 */
export function recordRecallFeedback(deps: FeedbackDeps, input: RecallFeedbackInput): void {
  if (input.feedback === undefined) {
    return;
  }
  for (const [field, kind] of REPORT_KINDS) {
    for (const report of input.feedback[field] ?? []) {
      try {
        const recorded = appendSelfReportEvent(deps.db, kind, {
          key: selfReportKey(kind, input, report),
          sessionId: input.sessionId,
          memories: report.memories,
          reporter: report.reporter,
          ...(report.evidence === undefined ? {} : { evidence: report.evidence }),
          occurredAt: report.occurred_at === undefined ? input.now : new Date(report.occurred_at),
        });
        deps.logger.debug(
          { sessionId: input.sessionId, kind, memories: report.memories.length, recorded },
          'feedback report stated',
        );
      } catch (err) {
        deps.logger.warn(
          { err, sessionId: input.sessionId, kind },
          'feedback report append failed',
        );
      }
    }
  }
}

/** Same digest rule, over what makes one confirmation the same statement as another. */
function confirmationKey(episodeId: string, confirmation: ConfirmationWrite): string {
  return `feedback:memory_confirmed:${hashContent({
    episodeId,
    target: confirmation.target,
    by: confirmation.by,
    evidence: confirmation.evidence,
  })}`;
}

/**
 * The confirmations an experience attached, mirrored into the stream so a confirmation is
 * observable beside the other two signals rather than only as a property on an edge.
 *
 * Only the ones that resolved reach here, so every row names a memory the substrate holds.
 *
 * Throws when the append fails, and the caller's own acknowledgement is what makes that the
 * right answer: a settle that swallowed this would mark the references applied over a signal it
 * never wrote, and every later settle would skip the episode. The throw leaves the version
 * unacknowledged, so the queue's own backoff runs the settle again. Rows already written stay
 * one row each, since the key is the statement rather than the attempt.
 */
export function recordConfirmationFeedback(
  deps: FeedbackDeps,
  episodeId: string,
  confirmations: readonly ConfirmationWrite[],
): void {
  for (const confirmation of confirmations) {
    appendMemoryConfirmedEvent(deps.db, {
      key: confirmationKey(episodeId, confirmation),
      episodeId,
      memories: [confirmation.target],
      confirmedBy: confirmation.by,
      evidence: confirmation.evidence,
      occurredAt: confirmation.at,
    });
  }
}
