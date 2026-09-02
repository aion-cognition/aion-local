import type { Driver } from 'neo4j-driver';

import {
  findRecentCurrentClaims,
  loadClaimDedupDetails,
  mergeClaimPair,
  type RecentClaim,
} from '../../../infrastructure/graph/claim-dedup-queries.js';
import { findContradictionCandidates } from '../../../infrastructure/graph/supersession-queries.js';
import {
  isLedgerApplied,
  listLedgerKeys,
  markLedgerApplied,
} from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  claimDedupPairKey,
  claimDedupScanKey,
  CLAIM_DEDUP_SCAN_PREFIX,
  selectClaimDedupSurvivor,
} from '../../domain/claim-dedup.js';
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

/** How far the fetch itself is allowed to grow, within one run, chasing `scanLimit` worth of
 * unstamped subjects. Bigger than `SCAN_CEILING` on purpose: `scanLimit` bounds how many
 * candidates a run judges, this bounds how deep into the current population it is willing to
 * read past subjects earlier runs already settled. */
const SCAN_FETCH_CEILING = 5000;

/**
 * How many neighbours a subject is offered. More than one because a subject whose nearest
 * neighbour a past run already judged would otherwise be stamped settled on the strength of a
 * pair nobody is going to revisit, and never reach its second-nearest. Small, because the pair
 * a run acts on is still the closest unjudged one.
 */
const NEIGHBOR_LIMIT = 5;

export function claimDedupRelevance(): number {
  return CLAIM_DEDUP_STANDING_RELEVANCE;
}

/**
 * The scan population, minus whatever earlier runs already settled. `findRecentCurrentClaims`
 * itself stays ledger-blind, the same way `retro_judgment_sweep`'s own history-walking scan keeps
 * its graph read separate from the sqlite ledger it filters against; the fetch here just grows
 * past `scanLimit` when the newest slice is mostly already-stamped subjects, so a run reaches
 * genuinely unexamined nodes instead of re-reading the same settled ones every tick.
 */
async function findUnscannedRecentClaims(
  driver: Driver,
  scanned: ReadonlySet<string>,
  scanLimit: number,
): Promise<RecentClaim[]> {
  let fetchLimit = scanLimit;
  for (;;) {
    const rows = await findRecentCurrentClaims(driver, fetchLimit);
    const unscanned = rows.filter((row) => !scanned.has(row.id));
    const exhausted = rows.length < fetchLimit;
    if (unscanned.length >= scanLimit || exhausted || fetchLimit >= SCAN_FETCH_CEILING) {
      return unscanned.slice(0, scanLimit);
    }
    fetchLimit = Math.min(SCAN_FETCH_CEILING, fetchLimit * SCAN_FACTOR);
  }
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
    enabled: (config) => config.maintenance.claimDedup,
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
      const scanned = new Set(
        listLedgerKeys(ctx.db, CLAIM_DEDUP_SCAN_PREFIX).map((key) =>
          key.slice(CLAIM_DEDUP_SCAN_PREFIX.length),
        ),
      );
      const recent = await findUnscannedRecentClaims(ctx.driver, scanned, scanLimit);
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
        // Marks this subject settled under every outcome below except a judge failure: a failed
        // call leaves it unstamped so the next run gives the same pairing another try.
        const stampScanned = (verdict: string): void => {
          markLedgerApplied(ctx.db, claimDedupScanKey(subject.id), { verdict });
        };

        const neighbors = await findContradictionCandidates(ctx.driver, {
          vector: subject.contentVector,
          excludeIds: [subject.id, ...takenLosers],
          threshold: floor,
          limit: NEIGHBOR_LIMIT,
        });
        if (neighbors.length === 0) {
          stampScanned('clean');
          continue;
        }

        // The closest neighbour this pair has not already been judged against. Stamping the
        // subject on the first already-judged pair would retire it while its next-nearest
        // neighbour had never been looked at.
        const unjudged = neighbors
          .map((entry) => ({ entry, pairKey: claimDedupPairKey(subject.id, entry.id) }))
          .find(({ pairKey }) => !attempted.has(pairKey) && !isLedgerApplied(ctx.db, pairKey));
        if (unjudged === undefined) {
          stampScanned('already-paired');
          continue;
        }
        const neighbor = unjudged.entry;
        const { pairKey } = unjudged;
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
          stampScanned('related');
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
          stampScanned('vetoed');
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
          stampScanned('stale');
          continue;
        }

        const { survivor, loser } = selectClaimDedupSurvivor(
          { id: subject.id, occurredAt: subjectDetail.occurredAt },
          { id: neighbor.id, occurredAt: candidateDetail.occurredAt },
        );
        const merge = await mergeClaimPair(ctx.driver, {
          survivorId: survivor.id,
          loserId: loser.id,
          now: ctx.now,
        });
        // The write re-reads currency under its own transaction, which is the reading that
        // decides: a side taken between the read above and the commit is stale, not merged.
        if (!merge.merged) {
          stale += 1;
          markLedgerApplied(ctx.db, pairKey, { verdict: 'stale' });
          stampScanned('stale');
          continue;
        }
        takenLosers.add(loser.id);
        merged += 1;
        stampScanned('merged');
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
