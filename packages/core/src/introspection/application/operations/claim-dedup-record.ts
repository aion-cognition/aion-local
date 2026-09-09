import type {
  JudgmentEvidence,
  JudgmentEvidenceOutcome,
} from '../../../evidence/application/judgment.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { publicationWrite } from '../../../infrastructure/sqlite/publication-bounded.js';
import { publicationInFlight } from '../../../infrastructure/sqlite/publication-coordinator-store.js';
import { claimDedupScanKey } from '../../domain/claim-dedup.js';

/**
 * Where one judged pair's terminal records are decided and written.
 *
 * A record and the check that permits it belong in the same transaction. Read the vantage first
 * and stamp afterwards, and a coverage activation commits in the gap between them: the pair is
 * then permanently settled under a contract nobody judged it under, and no later run reaches it
 * again. So the pending-publication reading, the vantage, the evidence and both stamps take one
 * immediate write. A competing publication either waits for that lock and finds the decision
 * already made, or takes it first and this decision records nothing.
 *
 * Every model call is behind this boundary, never inside it: the callback it commits is
 * synchronous, and the write primitive refuses an asynchronous one outright.
 */

export type DecisionDeps = {
  readonly db: SqliteHandle;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly evidence?: JudgmentEvidence;
};

export type DecisionSubject = {
  readonly subjectId: string;
  readonly candidateId: string;
  readonly pairKey: string;
  readonly assembled: JudgmentEvidenceOutcome;
};

/** What the run counts. The reasons are logged here, beside the pair they are about. */
export type DecisionTally = {
  /** A pair left owed because the reading or the vantage it was judged on no longer stands. */
  readonly open: () => void;
  /** A pair whose record could not be taken at all. */
  readonly failed: () => void;
};

export type PairDecision = {
  /** Whether the pair may go on to work that carries a fence of its own. */
  settled(): boolean;
  /** Validates and stamps one terminal record for this pair and its subject. */
  record(verdict: string, summary: object): boolean;
  /** Both stamps for a decision whose own publication was already the boundary. */
  receipt(verdict: string, summary: object): void;
};

export function decideRecord(
  deps: DecisionDeps,
  subject: DecisionSubject,
  tally: DecisionTally,
): PairDecision {
  const { assembled } = subject;
  const scanKey = claimDedupScanKey(subject.subjectId);
  // The vantage travels with the evidence to every terminal record this pair can leave, not only
  // to the merge. A dismissal is a decision too, and one stamped under a contract that has since
  // been replaced reads as settled forever. A decision naming no vantage at all is refused the
  // same way the merge writer refuses one.
  const undecidable = (): string | undefined => {
    if (assembled.status !== 'ready' || deps.evidence === undefined) {
      return undefined;
    }
    const check =
      assembled.coverageEpoch === undefined
        ? ({ status: 'uncovered', reason: 'binding_absent' } as const)
        : deps.evidence.confirm(assembled.revision, { coverageEpoch: assembled.coverageEpoch });
    return check.status === 'current' ? undefined : check.status;
  };
  const leaveOpen = (reason: string): false => {
    tally.open();
    deps.logger.info(
      { subjectId: subject.subjectId, candidateId: subject.candidateId, check: reason },
      'claim dedup left a pair whose evidence moved while it was being judged',
    );
    return false;
  };
  const stamp = (verdict: string, summary: object): void => {
    markLedgerApplied(deps.db, subject.pairKey, { verdict, ...summary });
    markLedgerApplied(deps.db, scanKey, { verdict });
  };
  return {
    settled(): boolean {
      const reason = undecidable();
      return reason === undefined ? true : leaveOpen(reason);
    },
    record(verdict, summary): boolean {
      try {
        const refused = publicationWrite(deps.db, (): string | undefined => {
          // A publication already in flight may be the activation that moves the contract, and
          // nothing it writes is visible until it commits.
          if (publicationInFlight(deps.db)) {
            return 'pending_publication';
          }
          const reason = undecidable();
          if (reason !== undefined) {
            return reason;
          }
          stamp(verdict, summary);
          return undefined;
        });
        return refused === undefined ? true : leaveOpen(refused);
      } catch (err) {
        tally.failed();
        deps.logger.warn(
          { subjectId: subject.subjectId, candidateId: subject.candidateId, err },
          'claim dedup could not take the boundary its decision has to be recorded at',
        );
        return false;
      }
    },
    receipt(verdict, summary): void {
      try {
        publicationWrite(deps.db, () => {
          stamp(verdict, summary);
        });
      } catch (err) {
        deps.logger.warn(
          { subjectId: subject.subjectId, candidateId: subject.candidateId, err },
          'claim dedup applied this pair and could not record its receipt; a later run reads it as stale',
        );
      }
    },
  };
}
