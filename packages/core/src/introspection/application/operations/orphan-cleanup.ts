import { forgetNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import {
  findOrphanNodes,
  findOrphanRelinkTargets,
  type OrphanRelinkTarget,
} from '../../../infrastructure/graph/topology-queries.js';
import { criticalConditions, type HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * Orphan cleanup: relink what can be reconnected cheaply, forget what has been disconnected
 * long enough to say it is not coming back, and leave everything else alone.
 *
 * It answers the orphan condition, so its relevance is zero unless the snapshot actually meets
 * it. It reads that condition from `criticalConditions` rather than comparing against the
 * threshold itself, which is what stops the rule that selects the operation and the rule the
 * operation repairs from drifting apart.
 */

export const ORPHAN_CLEANUP_OPERATION = 'orphan_cleanup';

export const ORPHAN_RELINK_PROVENANCE = 'introspection';
export const ORPHAN_RELINK_SIGNAL = 'orphan_relink';

/**
 * A repair edge states that two nodes sit under the same wiring, which is weaker than
 * anything reflection infers from content. It is written weak on purpose: it exists to give
 * activation a path, and the real association that arrives later outranks it.
 */
export const ORPHAN_RELINK_STRENGTH = 0.2;
export const ORPHAN_RELINK_CONFIDENCE = 0.4;

const DAY_MS = 24 * 60 * 60 * 1000;

const RELINK_RATIONALE: Readonly<Record<OrphanRelinkTarget['kind'], string>> = {
  shared_entity: 'reconnected through an entity its container mentions',
  same_container: 'reconnected to a sibling under the same container',
};

export function orphanCleanupRelevance(health: HealthSnapshot): number {
  if (!criticalConditions(health).includes('orphan_share')) {
    return 0;
  }
  return Math.min(1, health.graph.orphanShare);
}

async function relink(ctx: OperationContext, target: OrphanRelinkTarget): Promise<void> {
  await upsertEdge(ctx.driver, {
    type: 'RELATED_TO',
    sourceId: target.orphanId,
    targetId: target.targetId,
    strength: ORPHAN_RELINK_STRENGTH,
    confidence: ORPHAN_RELINK_CONFIDENCE,
    signals: [ORPHAN_RELINK_SIGNAL, target.kind],
    provenance: [ORPHAN_RELINK_PROVENANCE],
    // A repair is a claim, not an observation, so a second run adds nothing to the count.
    count: 0,
    rationale: RELINK_RATIONALE[target.kind],
    now: ctx.now,
  });
}

async function runOrphanCleanup(ctx: OperationContext): Promise<OperationOutcome> {
  const orphans = await findOrphanNodes(ctx.driver, ctx.config.maintenance.orphanCleanupBatch);
  if (orphans.length === 0) {
    return { status: 'noop', itemsProcessed: 0, itemsAffected: 0, detail: 'no orphan in scope' };
  }

  const targets = new Map(
    (
      await findOrphanRelinkTargets(
        ctx.driver,
        orphans.map((orphan) => orphan.id),
      )
    ).map((target) => [target.orphanId, target]),
  );
  const forgetBefore = ctx.now.getTime() - ctx.config.maintenance.orphanForgetAfterDays * DAY_MS;

  let processed = 0;
  let relinked = 0;
  let forgotten = 0;
  for (const orphan of orphans) {
    if (ctx.signal.aborted) {
      break;
    }
    processed += 1;
    const target = targets.get(orphan.id);
    if (target !== undefined) {
      await relink(ctx, target);
      relinked += 1;
      continue;
    }
    // No candidate and no age: an orphan the substrate may still connect on its own. A node
    // with no stamp at all is never forgotten, since its age is unknown rather than large.
    if (orphan.txFrom !== undefined && orphan.txFrom.getTime() <= forgetBefore) {
      await forgetNode(ctx.driver, { id: orphan.id, now: ctx.now });
      forgotten += 1;
    }
  }

  const affected = relinked + forgotten;
  return {
    status: affected === 0 ? 'noop' : 'applied',
    itemsProcessed: processed,
    itemsAffected: affected,
    detail: `${String(relinked)} relinked, ${String(forgotten)} forgotten of ${String(processed)} orphans`,
  };
}

/**
 * The bucket matches the default tick, so a run that is preempting drains a batch every time
 * it is chosen rather than finding its own window already claimed. The preemption itself is
 * not open-ended: once the operation has run its grace out without moving `orphanShare`, the
 * decision engine scores it routinely and the rest of the catalog gets its turns back.
 */
export function orphanCleanupOperation(): IntrospectionOperation {
  return {
    name: ORPHAN_CLEANUP_OPERATION,
    answers: 'orphan_share',
    bucket: 'quarter-hour',
    relevance: orphanCleanupRelevance,
    measure: (health) => health.graph.orphanShare,
    improves: 'lower',
    run: runOrphanCleanup,
  };
}
