import { listEntityMergeProposals } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { applyEntityMergeProposal } from '../../../reflection/application/entity-merge-review.js';
import type { HealthSnapshot } from '../../domain/health.js';
import { AUTO_MERGE_METHOD, wouldAutoApply } from '../../domain/merge-shadow.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * Applies exact-name entity-merge proposals the way a person applying them by hand would: the
 * two names fold to the same string, so there is no judgment call left for a reviewer to make.
 * `merge_shadow` measured this rule against two live review batches before anything was allowed
 * to act on it. Every exact-name pair in both batches was a merge a person went on to approve,
 * and the rule never disagreed with a person on one; that measurement is what earned this
 * operation the right to merge rather than only record.
 *
 * A fuzzy pair, where the names differ, is left alone here. It stays open for `aion proposals`,
 * which is still where a person decides those.
 *
 * The `AION_AUTO_MERGE` knob turns this operation off without touching the shadow judge or the
 * queue: proposals keep arriving and stay open, nothing merges them, and flipping the knob is
 * the fast way back to fully manual review if something looks wrong. A merge this operation made
 * is reversed one at a time with `aion unmerge`, the same as any other entity merge.
 */

export const MERGE_AUTO_OPERATION = 'merge_auto';

/** Matches `merge_shadow`'s own divisor: ten open proposals reads as a full queue. */
const MERGE_AUTO_RELEVANCE_DIVISOR = 10;

/** A tick's ceiling on how many proposals get applied at once, independent of the knob. */
const MERGE_AUTO_BATCH_CEILING = 200;

export function mergeAutoRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.proposals.entityMergeOpen / MERGE_AUTO_RELEVANCE_DIVISOR);
}

export function mergeAutoOperation(): IntrospectionOperation {
  return {
    name: MERGE_AUTO_OPERATION,
    bucket: 'hour',
    relevance: mergeAutoRelevance,
    run: async (ctx): Promise<OperationOutcome> => {
      if (!ctx.config.maintenance.autoMerge) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'auto-merge disabled by AION_AUTO_MERGE; no proposals examined',
        };
      }

      const open = listEntityMergeProposals(ctx.db)
        .filter((proposal) => proposal.resolvedAt === null)
        .slice(0, MERGE_AUTO_BATCH_CEILING);

      let seen = 0;
      let applied = 0;
      let cleared = 0;
      let queued = 0;
      for (const proposal of open) {
        if (ctx.signal.aborted) {
          break;
        }
        seen += 1;

        if (!wouldAutoApply(proposal.leftName, proposal.rightName)) {
          queued += 1;
          ctx.logger.info(
            {
              proposalId: proposal.id,
              leftName: proposal.leftName,
              leftType: proposal.leftType,
              rightName: proposal.rightName,
              rightType: proposal.rightType,
              similarity: proposal.similarity,
              outcome: 'queued',
            },
            'merge auto left a fuzzy proposal for review',
          );
          continue;
        }

        const result = await applyEntityMergeProposal(ctx.driver, ctx.db, {
          id: proposal.id,
          method: AUTO_MERGE_METHOD,
          now: ctx.now,
        });
        if (result.outcome === 'applied') {
          applied += 1;
        } else {
          cleared += 1;
        }
        ctx.logger.info(
          {
            proposalId: proposal.id,
            leftName: proposal.leftName,
            leftType: proposal.leftType,
            rightName: proposal.rightName,
            rightType: proposal.rightType,
            similarity: proposal.similarity,
            outcome: result.outcome,
          },
          'merge auto judged an exact-name proposal',
        );
      }

      return {
        status: applied === 0 ? 'noop' : 'applied',
        itemsProcessed: seen,
        itemsAffected: applied,
        detail:
          `${String(applied)} exact-name proposal(s) auto-merged, ${String(cleared)} cleared, ` +
          `${String(queued)} left queued for review`,
      };
    },
  };
}
