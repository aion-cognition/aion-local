import { certifyNodeSupport } from '../../../evidence/application/node-support.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import {
  forgetOrphanNode,
  type OrphanRelinkTarget,
} from '../../../infrastructure/graph/topology-queries.js';
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
import {
  pendingProposals,
  qualificationEvidence,
  qualificationHolds,
  readOrphanCensus,
  type OrphanCensusEntry,
} from '../orphan-census.js';

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
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  return orphanRepairRelevance(health.graph.orphanActionable, health.graph.orphanCleanupBatch);
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

/**
 * The forget, taken only against a qualification the records still hold.
 *
 * The census decided this node was mature; this reads the qualification back before writing,
 * because a scope that moved between the two readings restarts the clock and a suppression has
 * no reopen path. The graph write carries the disconnection test with it for the same reason.
 */
async function forget(ctx: OperationContext, entry: OrphanCensusEntry): Promise<boolean> {
  const observation = readOrphanObservation(ctx.db, entry.nodeId);
  if (observation?.disposition !== 'unsupported') {
    return false;
  }
  // The qualification is only as good as what it rested on, so the whole predicate is derived
  // again here rather than the row being read back on its own word: the support reading, the
  // proposals holding the node up, and the policy the window ran under. Anything that moved
  // between the census and this write voids the window, and a suppression has no reopen path.
  if (observation.policyRevision !== (readCurrentReadinessPolicy(ctx.db)?.policyRevision ?? 0)) {
    return false;
  }
  const reading = certifyNodeSupport(ctx.db, entry.nodeId);
  const pending = pendingProposals(ctx.db, entry.nodeId);
  if (reading.support !== 'unsupported' || pending > 0) {
    return false;
  }
  if (
    !qualificationHolds(
      observation.evidenceRevision,
      qualificationEvidence(reading.evidenceRevision, pending),
    )
  ) {
    return false;
  }
  const forgetBefore = new Date(
    ctx.now.getTime() - ctx.config.maintenance.orphanForgetAfterDays * DAY_MS,
  );
  if (new Date(observation.firstVerifiedAt).getTime() > forgetBefore.getTime()) {
    return false;
  }
  return forgetOrphanNode(ctx.driver, { id: entry.nodeId, forgetBefore, now: ctx.now });
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
      await relink(ctx, entry.relinkTarget);
      relinked += 1;
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
