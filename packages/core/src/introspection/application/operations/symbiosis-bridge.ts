import {
  countBridgesBetween,
  findClosestCrossCommunityPair,
  writeBridge,
  type CrossCommunityPair,
} from '../../../infrastructure/graph/bridge-queries.js';
import {
  readCommunityProfiles,
  type CommunityProfile,
} from '../../../infrastructure/graph/community-queries.js';
import { OllamaProvider } from '../../../infrastructure/providers/ollama-provider.js';
import type { Vector } from '../../../infrastructure/providers/types.js';
import {
  CRITICAL_MIN_POPULATION,
  HEALTH_COLLECTORS,
  type HealthSnapshot,
} from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * The symbiosis bridge: one node joining the two neighbourhoods the graph connects least, so
 * activation starting in one can reach the other.
 *
 * Which pair to join is answered by the embeddings the substrate already holds, not by a
 * model. The vectors are the sanctioned statement of "these two are about the same thing",
 * they are already computed, and a deterministic choice is one a person can re-derive from
 * the graph months later. The bridge's own text names both endpoints and is embedded like any
 * other memory, so recall can reach the bridge directly as well as through it.
 */

export const SYMBIOSIS_BRIDGE_OPERATION = 'symbiosis_bridge';

/**
 * Under community refresh's, so a fresh labelling lands before the run that reads it. Both
 * reach the threshold on waiting time; this one just waits a little longer.
 */
export const SYMBIOSIS_BRIDGE_RELEVANCE = 0.15;

/** Members each side contributes to the cross product, which is what bounds the pair search. */
export const BRIDGE_CANDIDATE_LIMIT = 25;

/** The local embedder, the one call this operation makes outside the graph. */
export type BridgeEmbedder = (texts: readonly string[]) => Promise<Vector[]>;

export type SymbiosisBridgeOptions = {
  /** Test seam. Unset, the operation embeds through the configured local model. */
  readonly embed?: BridgeEmbedder;
};

export function symbiosisBridgeRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  if (health.graph.nodes < CRITICAL_MIN_POPULATION) {
    return 0;
  }
  return SYMBIOSIS_BRIDGE_RELEVANCE;
}

function defaultEmbedder(ctx: OperationContext): BridgeEmbedder {
  const provider = new OllamaProvider({
    baseUrl: ctx.config.ollama.url,
    embedModel: ctx.config.models.embed,
  });
  return (texts) => provider.embed(texts);
}

function bridgeSummary(pair: CrossCommunityPair): string {
  return `Bridge between two memory clusters: ${pair.leftLabel} and ${pair.rightLabel}`;
}

function bridgeRationale(
  left: CommunityProfile,
  right: CommunityProfile,
  pair: CrossCommunityPair,
): string {
  return (
    `closest pair by content vector between the two least connected clusters ` +
    `(${String(left.size)} and ${String(right.size)} members, ` +
    `${String(left.externalEdges)} and ${String(right.externalEdges)} outside edges), ` +
    `cosine ${pair.similarity.toFixed(3)}`
  );
}

function noop(detail: string, processed = 0): OperationOutcome {
  return { status: 'noop', itemsProcessed: processed, itemsAffected: 0, detail };
}

async function runSymbiosisBridge(
  ctx: OperationContext,
  embed: BridgeEmbedder,
): Promise<OperationOutcome> {
  const profiles = await readCommunityProfiles(
    ctx.driver,
    ctx.config.maintenance.bridgeMinCommunitySize,
  );
  const left = profiles[0];
  const right = profiles[1];
  if (left === undefined || right === undefined) {
    // Either community refresh has not run yet or the substrate holds one neighbourhood.
    // Neither is a fault, and neither is something a bridge would improve.
    return noop('fewer than two communities are large enough to bridge', profiles.length);
  }

  const processed = left.size + right.size;
  if ((await countBridgesBetween(ctx.driver, left.community, right.community)) > 0) {
    return noop('the two least connected communities are already bridged', processed);
  }

  const pair = await findClosestCrossCommunityPair(ctx.driver, {
    left: left.community,
    right: right.community,
    candidateLimit: BRIDGE_CANDIDATE_LIMIT,
    dimension: ctx.config.models.embedDimension,
  });
  if (pair === undefined) {
    return noop('neither community carries an embedded member to bridge from', processed);
  }
  if (ctx.signal.aborted) {
    return noop('shutting down before the bridge was written', processed);
  }

  const summary = bridgeSummary(pair);
  const vectors = await embed([summary]);
  const vector = vectors[0];
  if (vector === undefined || vector.length !== ctx.config.models.embedDimension) {
    // A bridge with a mis-dimensioned vector is worse than no bridge: the vector index takes
    // the write and every later search against it fails on the whole index.
    return {
      status: 'failed',
      itemsProcessed: processed,
      itemsAffected: 0,
      detail: 'the embedder answered at the wrong dimension',
    };
  }

  await writeBridge(ctx.driver, {
    sourceId: pair.leftId,
    targetId: pair.rightId,
    sourceCommunity: left.community,
    targetCommunity: right.community,
    similarity: pair.similarity,
    summary,
    rationale: bridgeRationale(left, right, pair),
    vector,
    now: ctx.now,
  });

  return {
    status: 'applied',
    itemsProcessed: processed,
    itemsAffected: 1,
    detail: `bridged two communities of ${String(left.size)} and ${String(right.size)} members at cosine ${pair.similarity.toFixed(3)}`,
  };
}

/**
 * One bridge per day. The bucket is the whole of the "one bridge per run" rule: the engine
 * claims it before the operation starts, so a second service instance on the same substrate
 * cannot write a second bridge into the same window.
 */
export function symbiosisBridgeOperation(
  options: SymbiosisBridgeOptions = {},
): IntrospectionOperation {
  return {
    name: SYMBIOSIS_BRIDGE_OPERATION,
    bucket: 'day',
    relevance: symbiosisBridgeRelevance,
    run: async (ctx): Promise<OperationOutcome> =>
      runSymbiosisBridge(ctx, options.embed ?? defaultEmbedder(ctx)),
  };
}
