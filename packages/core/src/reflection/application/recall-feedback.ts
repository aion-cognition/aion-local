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
 * The digest a repeat is recognised by. The clock stays out of it: a client retrying a push
 * states the same report again under a fresh wall clock, and a second row for one statement
 * would read as a second report. A caller with something new to say names other memories or says
 * it in other words, and either moves the digest.
 */
function selfReportKey(kind: SelfReportKind, sessionId: string, report: FeedbackReport): string {
  return `feedback:${kind}:${hashContent({
    sessionId,
    memories: report.memories,
    reporter: report.reporter,
    evidence: report.evidence ?? null,
  })}`;
}

export type RecallFeedbackInput = {
  readonly feedback: RecallFeedback | undefined;
  readonly sessionId: string;
  /** The stamp a report that named no time of its own is dated to. */
  readonly now: Date;
};

/**
 * Every report the call stated, recorded once each.
 *
 * Failure is logged and swallowed. The experience these rode in on is already durable, and a
 * signal the stream lost is not a reason to fail a write that succeeded.
 */
export function recordRecallFeedback(deps: FeedbackDeps, input: RecallFeedbackInput): void {
  if (input.feedback === undefined) {
    return;
  }
  for (const [field, kind] of REPORT_KINDS) {
    for (const report of input.feedback[field] ?? []) {
      try {
        const recorded = appendSelfReportEvent(deps.db, kind, {
          key: selfReportKey(kind, input.sessionId, report),
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
 */
export function recordConfirmationFeedback(
  deps: FeedbackDeps,
  episodeId: string,
  confirmations: readonly ConfirmationWrite[],
): void {
  for (const confirmation of confirmations) {
    try {
      appendMemoryConfirmedEvent(deps.db, {
        key: confirmationKey(episodeId, confirmation),
        episodeId,
        memories: [confirmation.target],
        confirmedBy: confirmation.by,
        evidence: confirmation.evidence,
        occurredAt: confirmation.at,
      });
    } catch (err) {
      deps.logger.warn({ err, episodeId }, 'confirmation feedback append failed');
    }
  }
}
