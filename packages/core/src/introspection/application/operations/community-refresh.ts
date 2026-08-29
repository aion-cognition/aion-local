import {
  CONTENT_PROJECTION_NAME,
  countProjectableNodes,
  dropProjection,
  labelPropagationAvailable,
  projectContentGraph,
  writeCommunities,
} from '../../../infrastructure/graph/community-queries.js';
import { CRITICAL_MIN_POPULATION } from '../../domain/decide.js';
import { HEALTH_COLLECTORS, type HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * Community refresh: re-derive which nodes belong together and stamp the answer on them, so
 * the bridge engine has neighbourhoods to reason about and `aion stats` has a shape to report.
 *
 * Like the decay sweep, there is no gauge in the snapshot that says how far the community
 * labels have drifted, and building one would mean running the algorithm to find out. So this
 * declares a low standing relevance and reaches the urgency threshold on waiting time, which
 * is what a scheduled cadence looks like in a loop where everything else is triggered.
 */

export const COMMUNITY_REFRESH_OPERATION = 'community_refresh';

/** Slightly above decay's, since a stale labelling holds up the bridge engine behind it. */
export const COMMUNITY_REFRESH_RELEVANCE = 0.2;

export function communityRefreshRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  // The same population floor the critical rules use: under it, community structure is a
  // description of noise. The real check is against the configured minimum, inside the run,
  // because relevance is given a snapshot and nothing else.
  if (health.graph.nodes < CRITICAL_MIN_POPULATION) {
    return 0;
  }
  return COMMUNITY_REFRESH_RELEVANCE;
}

/** A projection left behind is a leak, not a failure; the next run reclaims the name anyway. */
async function dropQuietly(ctx: OperationContext, graphName: string): Promise<void> {
  try {
    await dropProjection(ctx.driver, graphName);
  } catch (err) {
    ctx.logger.warn({ err, graphName }, 'community projection drop failed');
  }
}

async function runCommunityRefresh(ctx: OperationContext): Promise<OperationOutcome> {
  if (!(await labelPropagationAvailable(ctx.driver))) {
    return {
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'graph data science procedures are not available on this server',
    };
  }

  const projectable = await countProjectableNodes(ctx.driver);
  if (projectable < ctx.config.maintenance.communityMinNodes) {
    return {
      status: 'noop',
      itemsProcessed: projectable,
      itemsAffected: 0,
      detail: `substrate under the ${String(ctx.config.maintenance.communityMinNodes)}-node projection floor`,
    };
  }
  if (projectable > ctx.config.maintenance.communityNodeLimit) {
    return {
      status: 'noop',
      itemsProcessed: projectable,
      itemsAffected: 0,
      detail: `substrate over the ${String(ctx.config.maintenance.communityNodeLimit)}-node projection cap`,
    };
  }

  // Reclaim first. A previous run that died between project and drop left the name taken,
  // and the projection it left is a reading of a graph that has since moved on.
  await dropQuietly(ctx, CONTENT_PROJECTION_NAME);
  try {
    const projection = await projectContentGraph(ctx.driver, CONTENT_PROJECTION_NAME);
    if (projection.relationshipCount === 0) {
      return {
        status: 'noop',
        itemsProcessed: projection.nodeCount,
        itemsAffected: 0,
        detail: 'no association edge to propagate a community along',
      };
    }
    const written = await writeCommunities(ctx.driver, CONTENT_PROJECTION_NAME);
    return {
      status: written.nodePropertiesWritten === 0 ? 'noop' : 'applied',
      itemsProcessed: projection.nodeCount,
      itemsAffected: written.nodePropertiesWritten,
      detail:
        `${String(written.communityCount)} communities over ${String(projection.nodeCount)} nodes ` +
        `in ${String(written.ranIterations)} iterations, converged ${String(written.didConverge)}`,
    };
  } finally {
    await dropQuietly(ctx, CONTENT_PROJECTION_NAME);
  }
}

export function communityRefreshOperation(): IntrospectionOperation {
  return {
    name: COMMUNITY_REFRESH_OPERATION,
    tier: 2,
    bucket: 'day',
    relevance: communityRefreshRelevance,
    run: runCommunityRefresh,
  };
}
