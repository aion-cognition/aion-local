import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listStatedLinks,
  readStatedLinkValues,
  type StatedLinkRow,
} from '../../infrastructure/sqlite/evidence-links.js';
import { classifyReferenceTarget } from '../../infrastructure/sqlite/reference-targets.js';
import { recordEvidenceAcknowledgment } from '../../infrastructure/sqlite/source-lifecycle.js';
import { appendMemoryConfirmedEvent } from '../../infrastructure/sqlite/usage-events.js';
import { hashContent } from '../domain/content.js';

/**
 * The usage-stream half of a stated confirmation: when a `memory_confirmed` row is owed, when it
 * is written, and what it says.
 *
 * A confirmation is a claim about a memory, so the row is written only where the substrate can
 * name the memory it is about. Accepting the statement is a separate thing and happens either
 * way: the durable records keep what the caller said against the identity they named, and this
 * signal stays owed until that identity resolves.
 */

/**
 * The signal a stated confirmation owes the usage stream once its target is a memory the
 * substrate can name. It is its own obligation, apart from the statement's: a reader counting
 * owed signals must not be told a confirmation landed for an identity nothing accounts for.
 */
export const CONFIRMATION_SIGNAL_EFFECT = 'confirmation_signal';

/**
 * What makes one confirmation the same statement as another. The clock is out of it, so a
 * delivery restating the pair adds no row and a signal owed since an earlier batch lands once.
 */
export function confirmationEventKey(
  episodeId: string,
  target: string,
  by: string,
  evidence: string,
): string {
  return `feedback:memory_confirmed:${hashContent({ episodeId, target, by, evidence })}`;
}

/** One accepted confirmation, as the records answer it now rather than as a delivery stated it. */
type StatedConfirmation = {
  readonly targetId: string;
  readonly by: string;
  readonly evidence: string;
  /** The clock the first accepted version recorded, which is the statement's own moment. */
  readonly occurredAt: string;
  /** The batch that first accepted it, which is what the signal obligation hangs on. */
  readonly referenceVersion: number;
  /** Whether anything accounts for the target's identity. */
  readonly resolved: boolean;
};

/** The records answer first, so no graph presence is offered to this classification at all. */
const NO_RETAINED_NODES: ReadonlySet<string> = new Set<string>();

/**
 * Every confirmation this source has stated, one entry per target, carrying what the first
 * accepted version recorded and whether the target resolves now.
 *
 * Resolution is asked of the durable records and of the qualifiers the accepted versions carry,
 * never of the graph directly. A confirmation of a source whose raw projection is gone is
 * resolved, because the records name it. A target the records do not hold is resolved once some
 * accepted version recorded it under a qualifier other than unresolved, which only a plan
 * holding the graph could have decided.
 *
 * The read is over one source's statements, so it is bounded by how many confirmations that
 * source has ever stated rather than by the corpus.
 */
function statedConfirmations(db: SqliteHandle, sourceId: string): readonly StatedConfirmation[] {
  const byTarget = new Map<string, { first: StatedLinkRow; classified: boolean }>();
  for (const link of listStatedLinks(db, sourceId)) {
    if (link.kind !== 'confirms' || link.knownFrom === null) {
      continue;
    }
    const held = byTarget.get(link.toId);
    byTarget.set(link.toId, {
      first: held?.first ?? link,
      classified: (held?.classified ?? false) || link.qualifier !== 'unresolved',
    });
  }
  const confirmations: StatedConfirmation[] = [];
  for (const [targetId, entry] of byTarget) {
    const { by, evidence, occurredAt } = readStatedLinkValues(db, entry.first.linkId) ?? {};
    if (typeof by !== 'string' || typeof evidence !== 'string' || typeof occurredAt !== 'string') {
      continue;
    }
    confirmations.push({
      targetId,
      by,
      evidence,
      occurredAt,
      referenceVersion: entry.first.referenceVersion ?? 0,
      resolved:
        entry.classified ||
        classifyReferenceTarget(db, targetId, NO_RETAINED_NODES).targetClass !== 'unresolved',
    });
  }
  return confirmations;
}

export type ConfirmationSettlement = {
  readonly sourceId: string;
  readonly referenceVersion: number;
  /** The moment this acknowledgment observed, which is when a row it writes was recorded. */
  readonly observedAckAt: string;
};

/**
 * One event per confirmation whose target resolves, keyed on the statement rather than the
 * attempt, so a retry or a raw rebuild of the same source adds nothing. The payload and the
 * clock are the ones the first accepted version recorded: a later delivery restating the same
 * pair does not rewrite who confirmed it, what they cited, or when.
 *
 * A confirmation of an identity nothing accounts for writes no row and is not discarded either.
 * The statement stays durable and the signal stays owed, so the next settlement of any statement
 * this source makes emits it once the target has become something the substrate can name.
 * Writing the row anyway would file a confirmation of a memory nothing holds; dropping the
 * obligation would lose the signal for good.
 *
 * Every settlement sweeps the source's whole confirmation set rather than the batch it is
 * acknowledging, which is what lets a statement accepted against an unknown identity land later
 * without the caller having to say it again.
 */
export function settleConfirmationSignals(
  db: SqliteHandle,
  settlement: ConfirmationSettlement,
): void {
  for (const confirmation of statedConfirmations(db, settlement.sourceId)) {
    const owed = {
      sourceId: settlement.sourceId,
      referenceVersion: confirmation.referenceVersion,
      effectKind: CONFIRMATION_SIGNAL_EFFECT,
    };
    if (!confirmation.resolved) {
      recordEvidenceAcknowledgment(db, { ...owed, state: 'owed' });
      continue;
    }
    // The append comes first and the discharge second: a throw here takes the whole
    // acknowledgment, and a signal recorded as delivered over a row nothing wrote is a signal no
    // later settlement looks for again.
    appendMemoryConfirmedEvent(db, {
      key: confirmationEventKey(
        settlement.sourceId,
        confirmation.targetId,
        confirmation.by,
        confirmation.evidence,
      ),
      episodeId: settlement.sourceId,
      memories: [confirmation.targetId],
      confirmedBy: confirmation.by,
      evidence: confirmation.evidence,
      occurredAt: new Date(confirmation.occurredAt),
      recordedAt: new Date(settlement.observedAckAt),
    });
    recordEvidenceAcknowledgment(db, {
      ...owed,
      state: 'completed',
      completedAt: new Date(settlement.observedAckAt),
    });
  }
}
