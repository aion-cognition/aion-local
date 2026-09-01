import { z } from 'zod';

import {
  countBridgesBetween,
  findClosestCrossCommunityPair,
  writeBridge,
  type CrossCommunityPair,
} from '../../../infrastructure/graph/bridge-queries.js';
import {
  readCommunityPairEdges,
  readCommunityProfiles,
} from '../../../infrastructure/graph/community-queries.js';
import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
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
 * Three questions, answered in order and by different things. Which pair to join is answered
 * by the graph's own shape, scored on coherence, size balance, overlap and isolation, because
 * that is structure and structure is measurable. Which two members to anchor the bridge on is
 * answered by the embeddings the substrate already holds, which are its sanctioned statement
 * that two nodes are about the same thing. What the bridge says is the one question neither
 * answers: a model is asked for the sentence and the reason, and when it is unavailable, times
 * out, or answers with something unusable, a deterministic sentence naming both endpoints goes
 * in instead. That fallback is a floor, not the design.
 */

export const SYMBIOSIS_BRIDGE_OPERATION = 'symbiosis_bridge';

/**
 * Under community refresh's, so a fresh labelling lands before the run that reads it. Both
 * reach the threshold on waiting time; this one just waits a little longer.
 */
export const SYMBIOSIS_BRIDGE_RELEVANCE = 0.15;

/** Members each side contributes to the cross product, which is what bounds the pair search. */
export const BRIDGE_CANDIDATE_LIMIT = 25;

/** How many scored pairs the run will try before giving up on this window. */
export const BRIDGE_PAIR_ATTEMPTS = 3;

const BRIDGE_MAX_TOKENS = 400;

const BRIDGE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    rationale: { type: 'string' },
    compatibility: { type: 'number' },
  },
  required: ['summary', 'rationale', 'compatibility'],
};

const BridgeProposalSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  compatibility: z.number(),
});

const SYSTEM_PROMPT = [
  'You connect two clusters of memory in a personal memory system.',
  'You are given one memory from each cluster; the two were selected because their embeddings',
  'are closer to each other than any other pair across the clusters.',
  'Write a summary of one or two sentences naming what the two have in common, a rationale',
  'saying why an association between them is worth storing, and a compatibility score from 0',
  'to 1.',
  'State only what the two memories state; never invent a fact, a cause, or a relationship',
  'neither of them contains.',
  'If they have nothing in common, say so plainly and score the compatibility near zero.',
].join(' ');

const ENDPOINT_EXCERPT_CHARS = 400;

export function symbiosisBridgeRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  if (health.graph.nodes < CRITICAL_MIN_POPULATION) {
    return 0;
  }
  return SYMBIOSIS_BRIDGE_RELEVANCE;
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

type BridgeText = {
  readonly summary: string;
  readonly rationale: string;
  /** Present only on a proposal the model produced; the fallback has no judgment to report. */
  readonly compatibility?: number;
};

function deterministicText(pair: CommunityPairScore, closest: CrossCommunityPair): BridgeText {
  return {
    summary: `Bridge between two memory clusters: ${closest.leftLabel} and ${closest.rightLabel}`,
    rationale:
      `closest pair by content vector between two clusters scored ${pair.score.toFixed(3)} ` +
      `(${String(pair.left.size)} and ${String(pair.right.size)} members, ` +
      `coherence ${pair.coherence.toFixed(2)}, balance ${pair.sizeBalance.toFixed(2)}, ` +
      `overlap ${pair.overlap.toFixed(2)}, isolation ${pair.isolation.toFixed(2)}), ` +
      `cosine ${closest.similarity.toFixed(3)}`,
  };
}

function buildMessages(pair: CommunityPairScore, closest: CrossCommunityPair): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Cluster A (${String(pair.left.size)} memories): ` +
        `${clip(closest.leftLabel, ENDPOINT_EXCERPT_CHARS)}\n\n` +
        `Cluster B (${String(pair.right.size)} memories): ` +
        `${clip(closest.rightLabel, ENDPOINT_EXCERPT_CHARS)}\n\n` +
        `Embedding cosine between them: ${closest.similarity.toFixed(3)}`,
    },
  ];
}

/**
 * The model stage, and the one thing it may not do is fail loudly. A bridge is an enhancement,
 * so a model that is down, slow, or answering nonsense costs the sentence and not the run.
 */
async function proposeBridgeText(
  ctx: OperationContext,
  pair: CommunityPairScore,
  closest: CrossCommunityPair,
): Promise<BridgeText> {
  const fallback = deterministicText(pair, closest);
  const deadline = deadlineFor(ctx.config.reflection.stageTimeoutMs, ctx.signal);
  try {
    const raw = await ctx.provider.generate({
      model: ctx.config.models.reflect,
      messages: buildMessages(pair, closest),
      schema: BRIDGE_JSON_SCHEMA,
      maxTokens: BRIDGE_MAX_TOKENS,
      think: false,
      signal: deadline.signal,
    });
    const proposal = BridgeProposalSchema.parse(raw);
    const summary = proposal.summary.trim();
    const rationale = proposal.rationale.trim();
    if (summary.length === 0 || rationale.length === 0) {
      return fallback;
    }
    return { summary, rationale, compatibility: proposal.compatibility };
  } catch (err) {
    ctx.logger.warn({ err }, 'bridge proposal generation failed; writing the deterministic bridge');
    return fallback;
  } finally {
    deadline.clear();
  }
}

function noop(detail: string, processed = 0): OperationOutcome {
  return { status: 'noop', itemsProcessed: processed, itemsAffected: 0, detail };
}

type BridgeCandidate = {
  readonly pair: CommunityPairScore;
  readonly closest: CrossCommunityPair;
};

/**
 * The best-scoring pair that is not already bridged and has an embedded member each side.
 * Bounded: a substrate with many communities would otherwise spend the window walking a list
 * whose tail scores near zero anyway.
 */
async function selectCandidate(
  ctx: OperationContext,
  ranked: readonly CommunityPairScore[],
): Promise<BridgeCandidate | undefined> {
  for (const pair of ranked.slice(0, BRIDGE_PAIR_ATTEMPTS)) {
    if (ctx.signal.aborted) {
      return undefined;
    }
    if ((await countBridgesBetween(ctx.driver, pair.left.community, pair.right.community)) > 0) {
      continue;
    }
    const closest = await findClosestCrossCommunityPair(ctx.driver, {
      left: pair.left.community,
      right: pair.right.community,
      candidateLimit: BRIDGE_CANDIDATE_LIMIT,
      dimension: ctx.config.models.embedDimension,
    });
    if (closest !== undefined) {
      return { pair, closest };
    }
  }
  return undefined;
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

  const candidate = await selectCandidate(ctx, ranked);
  if (candidate === undefined) {
    return noop(
      'the best-scoring pairs are bridged already or carry no embedded member',
      profiles.length,
    );
  }

  const { pair, closest } = candidate;
  const processed = pair.left.size + pair.right.size;
  if (ctx.signal.aborted) {
    return noop('shutting down before the bridge was written', processed);
  }

  const text = await proposeBridgeText(ctx, pair, closest);
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
    sourceId: closest.leftId,
    targetId: closest.rightId,
    sourceCommunity: pair.left.community,
    targetCommunity: pair.right.community,
    similarity: closest.similarity,
    summary: text.summary,
    rationale: text.rationale,
    vector,
    now: ctx.now,
  });

  const source = text.compatibility === undefined ? 'deterministic' : 'model-proposed';
  return {
    status: 'applied',
    itemsProcessed: processed,
    itemsAffected: 1,
    detail:
      `${source} bridge between communities of ${String(pair.left.size)} and ` +
      `${String(pair.right.size)} members, pair score ${pair.score.toFixed(3)}, ` +
      `cosine ${closest.similarity.toFixed(3)}`,
  };
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
