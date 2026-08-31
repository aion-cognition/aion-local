import {
  findRecentCurrentClaims,
  loadClaimDedupDetails,
  mergeClaimPair,
} from '../../../infrastructure/graph/claim-dedup-queries.js';
import { findContradictionCandidates } from '../../../infrastructure/graph/supersession-queries.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { claimDedupPairKey, selectClaimDedupSurvivor } from '../../domain/claim-dedup.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';
import {
  judgeClaimDedup,
  reviewClaimDedup,
  type ClaimDedupCallOptions,
  type ClaimDedupPair,
} from '../claim-dedup-judge.js';

/**
 * Claim-level dedup: two adjacent episodes restate the same fact, extraction writes a fresh
 * node for each, and nothing before this folded the second into the first. Mirrors
 * `merge-auto-operation.ts`'s skeleton: a kill switch, a bounded batch, and a write that never
 * runs without a judge agreeing twice.
 *
 * Candidates are the nearest current neighbor of each recently-extracted claim, at or above
 * `claimDedupCosineFloor`. A pair is judged at most once, ever: `claimDedupPairKey`'s permanent
 * ledger entry covers every terminal answer except a technical failure, so a re-run never pays
 * twice for a verdict it already has and a transient outage never loses one for good.
 */

export const CLAIM_DEDUP_OPERATION = 'claim_dedup';

/** No gauge in the snapshot answers "how many near-duplicate claims are waiting", only the
 * ledger does, so this is a standing cadence rather than a backlog reading, the same posture
 * `retro_judgment_sweep` takes for its own backlog. */
export const CLAIM_DEDUP_STANDING_RELEVANCE = 0.1;

/** How far past one batch's worth of pairs the scan reaches, so already-ledgered neighbors
 * along the way do not stall a run short of its batch. Matches `retro_judgment_sweep`'s own
 * ratio. */
const SCAN_FACTOR = 10;
const SCAN_CEILING = 500;

export function claimDedupRelevance(): number {
  return CLAIM_DEDUP_STANDING_RELEVANCE;
}

function toPair(
  subject: { label: string; text: string },
  candidate: { label: string; text: string },
): ClaimDedupPair {
  return {
    subjectLabel: subject.label,
    subject: subject.text,
    candidateLabel: candidate.label,
    candidate: candidate.text,
  };
}

export function claimDedupOperation(): IntrospectionOperation {
  return {
    name: CLAIM_DEDUP_OPERATION,
    bucket: 'hour',
    relevance: claimDedupRelevance,
    run: async (ctx): Promise<OperationOutcome> => {
      if (!ctx.config.maintenance.claimDedup) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'claim dedup disabled by AION_MAINTENANCE_CLAIM_DEDUP; no claims examined',
        };
      }

      const batch = ctx.config.maintenance.claimDedupBatch;
      const floor = ctx.config.maintenance.claimDedupCosineFloor;
      const scanLimit = Math.min(SCAN_CEILING, batch * SCAN_FACTOR);
      const recent = await findRecentCurrentClaims(ctx.driver, scanLimit);
      const callOptions: ClaimDedupCallOptions = {
        model: ctx.config.models.reflect,
        timeoutMs: ctx.config.reflection.stageTimeoutMs,
        signal: ctx.signal,
      };

      // Excludes a node this run has already closed as a loser, both from the vector search
      // (so it cannot resurface as someone else's nearest neighbor) and from starting a pair
      // of its own, which `takenLosers.has` at the top of the loop catches.
      const takenLosers = new Set<string>();
      const attempted = new Set<string>();
      let judged = 0;
      let merged = 0;
      let related = 0;
      let vetoed = 0;
      let stale = 0;
      let failed = 0;

      for (const subject of recent) {
        if (ctx.signal.aborted || judged >= batch) {
          break;
        }
        if (takenLosers.has(subject.id)) {
          continue;
        }

        const neighbors = await findContradictionCandidates(ctx.driver, {
          vector: subject.contentVector,
          excludeIds: [subject.id, ...takenLosers],
          threshold: floor,
          limit: 1,
        });
        const neighbor = neighbors[0];
        if (neighbor === undefined) {
          continue;
        }

        const pairKey = claimDedupPairKey(subject.id, neighbor.id);
        if (attempted.has(pairKey) || isLedgerApplied(ctx.db, pairKey)) {
          continue;
        }
        attempted.add(pairKey);
        judged += 1;

        const pair = toPair(subject, neighbor);
        const detection = await judgeClaimDedup(ctx.provider, pair, callOptions);
        if (detection.status === 'failed') {
          failed += 1;
          ctx.logger.warn(
            { subjectId: subject.id, candidateId: neighbor.id, detail: detection.detail },
            'claim dedup detection failed',
          );
          continue;
        }
        if (!detection.judgment.same) {
          related += 1;
          markLedgerApplied(ctx.db, pairKey, {
            verdict: 'related',
            rationale: detection.judgment.rationale,
          });
          continue;
        }

        const review = await reviewClaimDedup(ctx.provider, pair, callOptions);
        if (review.status === 'failed') {
          failed += 1;
          ctx.logger.warn(
            { subjectId: subject.id, candidateId: neighbor.id, detail: review.detail },
            'claim dedup review failed',
          );
          continue;
        }
        if (review.review.outcome === 'vetoed') {
          vetoed += 1;
          markLedgerApplied(ctx.db, pairKey, { verdict: 'vetoed', reason: review.review.reason });
          continue;
        }

        // Read immediately before the write: the two model calls above took long enough that a
        // third act (another operation's close, or a person's own correction) could have taken
        // one side's currency in the meantime.
        const details = await loadClaimDedupDetails(ctx.driver, [subject.id, neighbor.id]);
        const subjectDetail = details.find((detail) => detail.id === subject.id);
        const candidateDetail = details.find((detail) => detail.id === neighbor.id);
        if (subjectDetail?.current !== true || candidateDetail?.current !== true) {
          stale += 1;
          markLedgerApplied(ctx.db, pairKey, { verdict: 'stale' });
          continue;
        }

        const { survivor, loser } = selectClaimDedupSurvivor(
          { id: subject.id, occurredAt: subjectDetail.occurredAt },
          { id: neighbor.id, occurredAt: candidateDetail.occurredAt },
        );
        await mergeClaimPair(ctx.driver, {
          survivorId: survivor.id,
          loserId: loser.id,
          now: ctx.now,
        });
        takenLosers.add(loser.id);
        merged += 1;
        markLedgerApplied(ctx.db, pairKey, {
          verdict: 'merged',
          survivorId: survivor.id,
          loserId: loser.id,
        });
      }

      return {
        status: merged === 0 ? 'noop' : 'applied',
        itemsProcessed: judged,
        itemsAffected: merged,
        detail:
          `${String(judged)} pair(s) judged: ${String(merged)} merged, ${String(related)} related, ` +
          `${String(vetoed)} vetoed, ${String(stale)} stale, ${String(failed)} failed`,
      };
    },
  };
}
