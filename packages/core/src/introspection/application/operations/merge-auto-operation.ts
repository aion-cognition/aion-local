import {
  applyEntityMerge,
  collectMergeSignals,
} from '../../../reflection/application/entity-merge-writer.js';
import {
  EntityDetailCache,
  findTier0Groups,
} from '../../../reflection/application/stages/entity-dedup-cascade.js';
import type { HealthSnapshot } from '../../domain/health.js';
import { AUTO_MERGE_METHOD } from '../../domain/merge-shadow.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * Tier 0 of the entity cascade, swept over the whole current graph rather than over one
 * episode's entities. The reflection stage runs the same two readings on what it just touched;
 * this catches the pair neither side of which any recent episode mentioned, which is most of
 * them once a graph has some history.
 *
 * What it merges is what the graph is already holding twice: two spellings of one name that the
 * `name_norm` uniqueness key cannot see, and an identity that already answers to another's name
 * as an alias. No model call is made and none is wanted, because neither reading is a judgment
 * about the world.
 *
 * The exact-name rule this operation used to carry is retired with the identity key that made
 * it necessary. Two current entities can no longer hold one folded name, so an exact-name pair
 * is a shape the graph stopped producing; the spellings that key apart are what is left, and
 * they are exactly what the old rule could not see.
 *
 * The `AION_AUTO_MERGE` knob turns the sweep off without touching anything else. A merge this
 * operation made is reversed one at a time with `aion unmerge`, which cites the decision record
 * written here, the same as any other entity merge.
 */

export const MERGE_AUTO_OPERATION = 'merge_auto';

/** Matches `merge_shadow`'s own divisor: ten open proposals reads as a full queue. */
const MERGE_AUTO_RELEVANCE_DIVISOR = 10;

/** A tick's ceiling on groups swept at once, independent of the knob. */
const MERGE_AUTO_GROUP_CEILING = 200;

export function mergeAutoRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.proposals.entityMergeOpen / MERGE_AUTO_RELEVANCE_DIVISOR);
}

export function mergeAutoOperation(): IntrospectionOperation {
  return {
    name: MERGE_AUTO_OPERATION,
    bucket: 'hour',
    relevance: mergeAutoRelevance,
    // The residue lane is what this is scored on: every identity the deterministic sweep
    // absorbs is a side some open proposal was asking about, and the stale sweep resolves the
    // row once the side is gone. An operation with no metric in the snapshot is scored on
    // whether it applied anything, which is a measure that cannot fail.
    measure: (health) => health.proposals.entityMergeOpen,
    run: async (ctx): Promise<OperationOutcome> => {
      if (!ctx.config.maintenance.autoMerge) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'auto-merge disabled by AION_AUTO_MERGE; nothing swept',
        };
      }

      const cache = new EntityDetailCache(ctx.driver);
      const groups = await findTier0Groups(ctx.driver, cache, { limit: MERGE_AUTO_GROUP_CEILING });

      let seen = 0;
      let merged = 0;
      let applied = 0;
      for (const group of groups) {
        if (ctx.signal.aborted) {
          break;
        }
        seen += 1;

        const signals = await collectMergeSignals(ctx.driver, group.canonical, group.members);
        const result = await applyEntityMerge(
          { driver: ctx.driver, db: ctx.db, logger: ctx.logger },
          {
            canonical: group.canonical,
            members: group.members,
            tier: 'tier0',
            reasons: group.reasons,
            signals,
            method: AUTO_MERGE_METHOD,
            now: ctx.now,
          },
        );
        if (result.status !== 'merged') {
          continue;
        }
        for (const id of result.mergedIds) {
          cache.absorb(id);
        }
        merged += result.mergedIds.length;
        applied += 1;
        ctx.logger.info(
          {
            canonicalId: group.canonical.id,
            mergedIds: result.mergedIds,
            decisionId: result.decisionId,
            reasons: group.reasons,
          },
          'merge auto absorbed a duplicate spelling',
        );
      }

      return {
        status: merged === 0 ? 'noop' : 'applied',
        itemsProcessed: seen,
        itemsAffected: merged,
        detail: `${String(merged)} identity(ies) merged across ${String(applied)} deterministic group(s)`,
      };
    },
  };
}
