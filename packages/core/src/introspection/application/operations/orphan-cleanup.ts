import type { OrphanRelinkTarget } from '../../../infrastructure/graph/topology-queries.js';
import { readOrphanObservation } from '../../../infrastructure/sqlite/orphan-observations.js';
import { readCurrentReadinessPolicy } from '../../../infrastructure/sqlite/readiness-policies.js';
import type { HealthSnapshot } from '../../domain/health.js';
import { HEALTH_COLLECTORS } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';
import { orphanRepairRelevance } from '../../domain/orphan-policy.js';
import { readOrphanCensus, type OrphanCensusEntry } from '../orphan-census.js';
import { orphanRelinkOperationId, orphanSuppressionOperationId } from './orphan-suppression.js';

/**
 * Orphan repair: relink what can be reconnected cheaply, suppress what the records certify
 * nothing holds up and that has been that way long enough to say it is not coming back, and
 * leave everything else alone.
 *
 * It is scored on demand rather than on the share of the graph that is disconnected. The share
 * moves with the substrate's shape and says nothing about whether a run has work: an
 * archive-supported memory whose raw containers were evicted is disconnected and is exactly the
 * memory the substrate exists to keep. What decides a repair is support, and support nobody has
 * counted decides nothing.
 *
 * The operation declares no metric. The old ratio measured the disconnection share, which this
 * population change makes a different number about a different thing, so its effectiveness is
 * unmeasured until a replacement has been validated against the new demand.
 */

export const ORPHAN_CLEANUP_OPERATION = 'orphan_cleanup';

const DAY_MS = 24 * 60 * 60 * 1000;

export function orphanCleanupRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  return orphanRepairRelevance(health.graph.orphanActionable, health.graph.orphanCleanupBatch);
}

/**
 * The repair edge, published rather than written here.
 *
 * The certification is a present-tense claim about a pair, and the edge is a present-tense write.
 * They belong in one operation: the guard re-derives the proof and writes the edge under the same
 * receipt, so a source that closed its incidence on either end between the census and the write
 * refuses the repair instead of being written over. A run with no guard composed declines.
 */
async function relink(ctx: OperationContext, target: OrphanRelinkTarget): Promise<boolean> {
  if (ctx.topology === undefined) {
    return false;
  }
  const outcome = await ctx.topology.publish({
    kind: 'topology_update',
    operationId: orphanRelinkOperationId(target.orphanId, target.targetId, ctx.now),
    payload: {
      mode: 'relink',
      orphanId: target.orphanId,
      targetId: target.targetId,
      relinkKind: target.kind,
    },
  });
  if (outcome.status !== 'acknowledged') {
    ctx.logger.info(
      { node: target.orphanId, status: outcome.status, reason: outcome.reason },
      'orphan relink refused under the guard',
    );
    return false;
  }
  return (outcome.result as { relinked?: boolean }).relinked === true;
}

/**
 * The forget, taken only against a qualification the records still hold.
 *
 * The census decided this node was mature; this reads the qualification back before writing,
 * because a scope that moved between the two readings restarts the clock and a suppression has
 * no reopen path. The graph write carries the disconnection test with it for the same reason.
 */
async function forget(ctx: OperationContext, entry: OrphanCensusEntry): Promise<boolean> {
  if (ctx.topology === undefined) {
    // No guard to publish under. A suppression has no reopen path, so the run declines rather
    // than writing a permanent decision through a path whose lost commit response nobody could
    // resolve; the qualification stays and the next composed run decides.
    return false;
  }
  const observation = readOrphanObservation(ctx.db, entry.nodeId);
  if (observation?.disposition !== 'unsupported') {
    return false;
  }
  const forgetBefore = new Date(
    ctx.now.getTime() - ctx.config.maintenance.orphanForgetAfterDays * DAY_MS,
  );
  // The whole predicate is re-derived under the guard, not here: the support reading, the
  // proposals, the policy the window ran under and every scope version it named. This publishes
  // the decision and the write together, so an evidence, proposal or state change landing between
  // the census and the suppression defers the operation instead of being written over.
  const outcome = await ctx.topology.publish({
    kind: 'topology_update',
    operationId: orphanSuppressionOperationId(entry.nodeId, ctx.now),
    payload: {
      nodeId: entry.nodeId,
      policyRevision: observation.policyRevision,
      forgetBefore: forgetBefore.toISOString(),
    },
  });
  if (outcome.status !== 'acknowledged') {
    ctx.logger.info(
      { node: entry.nodeId, status: outcome.status, reason: outcome.reason },
      'orphan suppression refused under the guard',
    );
    return false;
  }
  return (outcome.result as { suppressed?: boolean }).suppressed === true;
}

async function runOrphanCleanup(ctx: OperationContext): Promise<OperationOutcome> {
  const census = await readOrphanCensus(
    { driver: ctx.driver, db: ctx.db },
    {
      limit: ctx.config.maintenance.orphanCleanupBatch,
      now: ctx.now,
      forgetAfterDays: ctx.config.maintenance.orphanForgetAfterDays,
      policyRevision: readCurrentReadinessPolicy(ctx.db)?.policyRevision ?? 0,
    },
  );
  if (census.entries.length === 0) {
    return { status: 'noop', itemsProcessed: 0, itemsAffected: 0, detail: 'no orphan in scope' };
  }

  let processed = 0;
  let relinked = 0;
  let forgotten = 0;
  for (const entry of census.entries) {
    if (ctx.signal.aborted) {
      break;
    }
    processed += 1;
    if (entry.decision.action === 'relink' && entry.relinkTarget !== undefined) {
      if (await relink(ctx, entry.relinkTarget)) {
        relinked += 1;
      }
      continue;
    }
    if (entry.decision.action === 'forget' && (await forget(ctx, entry))) {
      forgotten += 1;
    }
  }

  const affected = relinked + forgotten;
  return {
    status: affected === 0 ? 'noop' : 'applied',
    itemsProcessed: processed,
    itemsAffected: affected,
    detail:
      `${String(relinked)} relinked, ${String(forgotten)} forgotten of ${String(processed)} ` +
      `disconnected (${String(census.unknownSupport)} with uncounted support, ` +
      `${String(census.unsupportedYoung)} not yet mature)`,
  };
}

/**
 * The bucket matches the default tick, so a run drains a batch every time it is chosen. It
 * preempts nothing: disconnection is a diagnostic rather than a critical condition, so this runs
 * on its demand score beside the rest of the catalog.
 */
export function orphanCleanupOperation(): IntrospectionOperation {
  return {
    name: ORPHAN_CLEANUP_OPERATION,
    bucket: 'quarter-hour',
    relevance: orphanCleanupRelevance,
    run: runOrphanCleanup,
  };
}
