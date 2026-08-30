import { listEntityMergeProposals } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import type { HealthSnapshot } from '../../domain/health.js';
import { mergeShadowLedgerKey, verdictOf, wouldAutoApply } from '../../domain/merge-shadow.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * Records what an auto-merge policy would decide on every entity-merge proposal, without
 * ever writing to the graph and without resolving a proposal itself. The point is to let the
 * policy's would-be verdicts accumulate against what people actually decide, so `aion stats`
 * can show the agreement before anyone arms the policy for real.
 *
 * Each proposal is judged once, open or already resolved. The rule is a deterministic function
 * of the row's stored names, so a verdict reached after a person resolved the row is the same
 * verdict the shadow would have reached before; the ledger payload records which order it was.
 * The verdict is stamped under a permanent key (`merge_shadow:{proposalId}`), not the
 * time-bucketed kind other operations use for their own turn, so it survives resolution.
 */

export const MERGE_SHADOW_OPERATION = 'merge_shadow';

/**
 * A live gauge already exists in the health snapshot, so this scales relevance on the same
 * count `aion proposals ls` shows rather than standing at a fixed value like the operations
 * with no gauge of their own. Ten open proposals is treated as a full queue, chosen the same
 * way `dead_letter`'s own divisor was: high enough that a stray proposal or two does not
 * dominate the tick's priorities, low enough that a real backlog is not ignored.
 */
const MERGE_SHADOW_RELEVANCE_DIVISOR = 10;

/** A tick's ceiling on how many proposals get judged at once, independent of any config knob. */
const MERGE_SHADOW_BATCH_CEILING = 200;

export function mergeShadowRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.proposals.entityMergeOpen / MERGE_SHADOW_RELEVANCE_DIVISOR);
}

export function mergeShadowOperation(): IntrospectionOperation {
  return {
    name: MERGE_SHADOW_OPERATION,
    bucket: 'hour',
    relevance: mergeShadowRelevance,
    run: (ctx): Promise<OperationOutcome> => {
      const proposals = listEntityMergeProposals(ctx.db);
      const unjudged = proposals
        .filter((proposal) => !isLedgerApplied(ctx.db, mergeShadowLedgerKey(proposal.id)))
        .slice(0, MERGE_SHADOW_BATCH_CEILING);

      let wouldApplyCount = 0;
      let wouldQueueCount = 0;
      for (const proposal of unjudged) {
        if (ctx.signal.aborted) {
          break;
        }
        const wouldApply = wouldAutoApply(proposal.leftName, proposal.rightName);
        const verdict = verdictOf(wouldApply);
        ctx.logger.info(
          {
            proposalId: proposal.id,
            leftName: proposal.leftName,
            leftType: proposal.leftType,
            rightName: proposal.rightName,
            rightType: proposal.rightType,
            similarity: proposal.similarity,
            verdict,
          },
          'merge shadow judged a proposal',
        );
        markLedgerApplied(ctx.db, mergeShadowLedgerKey(proposal.id), {
          verdict,
          judgedAfterResolution: proposal.resolvedAt !== null,
        });
        if (wouldApply) {
          wouldApplyCount += 1;
        } else {
          wouldQueueCount += 1;
        }
      }

      const judged = wouldApplyCount + wouldQueueCount;
      return Promise.resolve({
        status: judged === 0 ? 'noop' : 'applied',
        itemsProcessed: proposals.length,
        itemsAffected: judged,
        detail:
          `${String(judged)} proposal(s) shadow-judged, ${String(wouldApplyCount)} would apply, ` +
          `${String(wouldQueueCount)} would queue`,
      });
    },
  };
}
