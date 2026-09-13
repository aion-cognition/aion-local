import {
  proposeBridge,
  type BridgeAnswer,
  type BridgeProposal,
  type CommunityContext,
} from './symbiosis-proposal.js';
import {
  countBridgesBetween,
  findClosestCrossCommunityPair,
  similarityBetween,
  writeBridge,
  type BridgeAuthor,
  type CrossCommunityPair,
} from '../../../infrastructure/graph/bridge-queries.js';
import {
  readCommunityMembers,
  readCommunityPairEdges,
  readCommunityProfiles,
  type CommunityMember,
} from '../../../infrastructure/graph/community-queries.js';
import { rankCommunityPairs, type CommunityPairScore } from '../../domain/bridge-pairs.js';
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
 * The symbiosis bridge: one node joining two neighbourhoods the graph connects least, so
 * activation starting in one can reach the other.
 *
 * Two questions, answered by two different things. Which pair of neighbourhoods to consider is
 * structure, and structure is measurable: coherence, size balance, overlap and isolation score
 * it. What relation runs between them, and which two members carry it, is inference, and the
 * model answers that from a profile of each community rather than from two nodes something else
 * already picked.
 *
 * The answer decides the run. A decline writes nothing. A compatibility under the floor writes
 * nothing. Neither falls back, because falling back would mean the model's judgment was a
 * suggestion and the deterministic pair was the real answer all along. The floor exists for a
 * model that never answered: unavailable, timed out, or returning something unreadable. Every
 * outcome says which path it took.
 */

export const SYMBIOSIS_BRIDGE_OPERATION = 'symbiosis_bridge';

/**
 * Under community refresh's, so a fresh labelling lands before the run that reads it. Both
 * reach the threshold on waiting time; this one just waits a little longer.
 */
export const SYMBIOSIS_BRIDGE_RELEVANCE = 0.15;

/** Members each side contributes to the fallback's cross product, which bounds the pair search. */
export const BRIDGE_CANDIDATE_LIMIT = 25;

/** How many scored pairs the run will try before giving up on this window. */
export const BRIDGE_PAIR_ATTEMPTS = 3;

export function symbiosisBridgeRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  if (health.graph.nodes < CRITICAL_MIN_POPULATION) {
    return 0;
  }
  return SYMBIOSIS_BRIDGE_RELEVANCE;
}

function noop(detail: string, processed = 0): OperationOutcome {
  return { status: 'noop', itemsProcessed: processed, itemsAffected: 0, detail };
}

/**
 * The best-scoring pair that is not already bridged and has members to read on both sides.
 * Bounded: a substrate with many communities would otherwise spend the window walking a list
 * whose tail scores near zero anyway.
 */
async function selectContext(
  ctx: OperationContext,
  ranked: readonly CommunityPairScore[],
): Promise<CommunityContext | undefined> {
  const sample = ctx.config.maintenance.bridgeMemberSample;
  for (const pair of ranked.slice(0, BRIDGE_PAIR_ATTEMPTS)) {
    if (ctx.signal.aborted) {
      return undefined;
    }
    if ((await countBridgesBetween(ctx.driver, pair.left.community, pair.right.community)) > 0) {
      continue;
    }
    const leftMembers = await readCommunityMembers(ctx.driver, pair.left.community, sample);
    const rightMembers = await readCommunityMembers(ctx.driver, pair.right.community, sample);
    if (leftMembers.length > 0 && rightMembers.length > 0) {
      return { pair, leftMembers, rightMembers };
    }
  }
  return undefined;
}

type BridgeText = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceRole: string;
  readonly targetRole: string;
  readonly summary: string;
  readonly rationale: string;
  readonly premises: readonly string[];
  readonly weight: number;
  readonly compatibility?: number;
  readonly author: BridgeAuthor;
};

function fromProposal(proposal: BridgeProposal): BridgeText {
  return {
    sourceId: proposal.sourceId,
    targetId: proposal.targetId,
    sourceRole: proposal.sourceRole,
    targetRole: proposal.targetRole,
    summary: proposal.summary,
    rationale: proposal.rationale,
    premises: proposal.premises,
    // The relation's own strength, which is what the model was asked for. The cosine between the
    // two endpoints is recorded on the node and weights nothing: a bridge worth storing often
    // runs between two memories that read nothing alike.
    weight: proposal.compatibility,
    compatibility: proposal.compatibility,
    author: 'model',
  };
}

/**
 * The floor under the design. It picks the closest cross-community pair by content vector and
 * says so in the text, because with no model answer the embeddings are the only statement the
 * substrate has that two nodes are about the same thing.
 */
function fromClosestPair(pair: CommunityPairScore, closest: CrossCommunityPair): BridgeText {
  return {
    sourceId: closest.leftId,
    targetId: closest.rightId,
    sourceRole: '',
    targetRole: '',
    summary: `Bridge between two memory clusters: ${closest.leftLabel} and ${closest.rightLabel}`,
    rationale:
      `closest pair by content vector between two clusters scored ${pair.score.toFixed(3)} ` +
      `(${String(pair.left.size)} and ${String(pair.right.size)} members, ` +
      `coherence ${pair.coherence.toFixed(2)}, balance ${pair.sizeBalance.toFixed(2)}, ` +
      `overlap ${pair.overlap.toFixed(2)}, isolation ${pair.isolation.toFixed(2)}), ` +
      `cosine ${closest.similarity.toFixed(3)}`,
    premises: [closest.leftLabel, closest.rightLabel],
    weight: closest.similarity,
    author: 'deterministic',
  };
}

/** What a member list can say about a node the text names, for the log line and nothing else. */
function labelOf(members: readonly CommunityMember[], id: string): string {
  return members.find((member) => member.id === id)?.label ?? id;
}

async function commitBridge(
  ctx: OperationContext,
  context: CommunityContext,
  text: BridgeText,
): Promise<OperationOutcome> {
  const { pair } = context;
  const processed = pair.left.size + pair.right.size;
  const similarity = await similarityBetween(ctx.driver, {
    leftId: text.sourceId,
    rightId: text.targetId,
    dimension: ctx.config.models.embedDimension,
  });

  // The role provider embeds through the configured local model whatever `generate` routes to.
  const vectors = await ctx.provider.embed([text.summary]);
  const vector = vectors[0];
  if (vector?.length !== ctx.config.models.embedDimension) {
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
    sourceId: text.sourceId,
    targetId: text.targetId,
    sourceCommunity: pair.left.community,
    targetCommunity: pair.right.community,
    ...(similarity === undefined ? {} : { similarity }),
    weight: text.weight,
    summary: text.summary,
    rationale: text.rationale,
    sourceRole: text.sourceRole,
    targetRole: text.targetRole,
    premises: text.premises,
    author: text.author,
    ...(text.compatibility === undefined ? {} : { compatibility: text.compatibility }),
    vector,
    now: ctx.now,
  });

  ctx.logger.info(
    {
      operation: SYMBIOSIS_BRIDGE_OPERATION,
      author: text.author,
      sourceId: text.sourceId,
      targetId: text.targetId,
      compatibility: text.compatibility,
      similarity,
    },
    'symbiosis bridge written',
  );

  const left = labelOf(context.leftMembers, text.sourceId);
  const right = labelOf(context.rightMembers, text.targetId);
  const cosine = similarity === undefined ? '' : `, cosine ${similarity.toFixed(3)}`;
  return {
    status: 'applied',
    itemsProcessed: processed,
    itemsAffected: 1,
    detail:
      `${text.author}-authored bridge between communities of ${String(pair.left.size)} and ` +
      `${String(pair.right.size)} members, pair score ${pair.score.toFixed(3)}, ` +
      `endpoints ${left} and ${right}${cosine}`,
  };
}

/**
 * The path taken when the model never answered. It is not taken when the model answered and
 * said no: a decline is the run's result.
 */
async function fallbackBridge(
  ctx: OperationContext,
  context: CommunityContext,
  why: string,
): Promise<OperationOutcome> {
  const { pair } = context;
  const processed = pair.left.size + pair.right.size;
  const closest = await findClosestCrossCommunityPair(ctx.driver, {
    left: pair.left.community,
    right: pair.right.community,
    candidateLimit: BRIDGE_CANDIDATE_LIMIT,
    dimension: ctx.config.models.embedDimension,
  });
  if (closest === undefined) {
    return noop(`${why}, and no member of either cluster carries a usable vector`, processed);
  }
  ctx.logger.warn(
    { operation: SYMBIOSIS_BRIDGE_OPERATION, reason: why },
    'bridge proposal did not arrive; writing the deterministic bridge',
  );
  return commitBridge(ctx, context, fromClosestPair(pair, closest));
}

/** What the answer means for the run, with the compatibility floor applied to a proposal. */
async function actOnAnswer(
  ctx: OperationContext,
  context: CommunityContext,
  answer: BridgeAnswer,
): Promise<OperationOutcome> {
  const processed = context.pair.left.size + context.pair.right.size;
  if (answer.status === 'declined') {
    return noop(`the model declined to bridge these two clusters: ${answer.reason}`, processed);
  }
  if (answer.status !== 'proposed') {
    return fallbackBridge(ctx, context, `the proposal ${answer.status}: ${answer.reason}`);
  }

  const floor = ctx.config.maintenance.bridgeMinCompatibility;
  const { compatibility, rationale } = answer.proposal;
  if (!(compatibility >= floor)) {
    // A weak relation stated confidently is the noise a bridge exists to be the opposite of,
    // and the model already said so. Writing it anyway and keeping the score as decoration is
    // what made the compatibility reading meaningless.
    return noop(
      `the model scored compatibility ${String(compatibility)}, under ` +
        `${String(floor)}: ${rationale}`,
      processed,
    );
  }
  return commitBridge(ctx, context, fromProposal(answer.proposal));
}

async function runSymbiosisBridge(ctx: OperationContext): Promise<OperationOutcome> {
  const profiles = await readCommunityProfiles(
    ctx.driver,
    ctx.config.maintenance.bridgeMinCommunitySize,
  );
  if (profiles.length < 2) {
    // Either community refresh has not run yet or the substrate holds one neighbourhood.
    // Neither is a fault, and neither is something a bridge would improve.
    return noop('fewer than two communities are large enough to bridge', profiles.length);
  }

  const ranked = rankCommunityPairs({
    profiles,
    pairEdges: await readCommunityPairEdges(ctx.driver),
    overlapCeiling: ctx.config.maintenance.bridgeOverlapCeiling,
  });
  if (ranked.length === 0) {
    return noop('every pair of communities is already connected or scores zero', profiles.length);
  }

  const context = await selectContext(ctx, ranked);
  if (context === undefined) {
    return noop(
      'the best-scoring pairs are bridged already or hold no readable member',
      profiles.length,
    );
  }
  if (ctx.signal.aborted) {
    return noop(
      'shutting down before the bridge was written',
      context.pair.left.size + context.pair.right.size,
    );
  }

  const answer = await proposeBridge(ctx.provider, context, {
    model: ctx.config.models.reflect,
    timeoutMs: ctx.config.reflection.stageTimeoutMs,
    signal: ctx.signal,
  });
  return actOnAnswer(ctx, context, answer);
}

/**
 * One bridge per day. The bucket is the whole of the "one bridge per run" rule: the engine
 * claims it before the operation starts, so a second service instance on the same substrate
 * cannot write a second bridge into the same window.
 */
export function symbiosisBridgeOperation(): IntrospectionOperation {
  return {
    name: SYMBIOSIS_BRIDGE_OPERATION,
    bucket: 'day',
    relevance: symbiosisBridgeRelevance,
    run: async (ctx): Promise<OperationOutcome> => runSymbiosisBridge(ctx),
  };
}
