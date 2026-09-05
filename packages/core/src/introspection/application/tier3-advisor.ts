import { z } from 'zod';

import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { errorMessage } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { deadlineFor } from '../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Provider } from '../../infrastructure/providers/types.js';
import {
  ADVICE_LOCAL as ADVICE_SYSTEM_PROMPT,
  REVIEW_LOCAL as REVIEW_SYSTEM_PROMPT,
} from '../../prompts/tier3-advisor.js';
import { describeEffectiveness, type OperationCandidate } from '../domain/decide.js';
import type { HealthSnapshot, OperationEffectiveness } from '../domain/health.js';
import type { Tier3Advisor, Tier3Outcome, Tier3Proposal, Tier3Request } from '../domain/tier3.js';

/**
 * The two model calls tier 3 makes: one that reads the snapshot and recommends an operation,
 * and one that argues the other side of whatever the first one named. Both are plain functions
 * carrying their own prompt and schema, so a battery measures the call the service runs rather
 * than a rebuilt copy of it.
 *
 * Neither call throws. A model that times out, refuses, or answers in a shape the schema will
 * not take is a cycle that recommends nothing, never a cycle that ends the loop.
 */

/** How the loop treats an accepted proposal: `propose` logs it, `act` runs it after a second pass. */
export type Tier3Mode = Config['maintenance']['tier3Mode'];

/** The pinned `AION_MAINTENANCE_TIER3_MODE`, set by the battery's measurement rather than by hand. */
export const DEFAULT_TIER3_MODE: Tier3Mode = DEFAULTS.maintenance.tier3Mode;

export type Tier3CallOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  /** The loop's own abort. A shutdown must not wait out a model call that has a minute left. */
  readonly signal?: AbortSignal;
};

/** What the model answers when the substrate needs nothing. Not an operation name. */
export const TIER3_NO_OPERATION = 'none';

/**
 * Both passes name the value rather than leaving it to the route's default: the provider sends
 * the parameter only when a caller names one, and a sampled second pass turns the review into a
 * coin flip over the same evidence the first pass already read.
 */
const TIER3_TEMPERATURE = 0;

const UNSTATED_CONFIDENCE = 0.5;

const NO_RATIONALE_GIVEN = 'the advisor gave no rationale';

function adviceSchema(names: readonly string[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: [...names, TIER3_NO_OPERATION] },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
    required: ['operation', 'rationale'],
  };
}

const REVIEW_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    upheld: { type: 'boolean' },
  },
  required: ['reason', 'upheld'],
};

/** Looser than the JSON schema on purpose: an answer missing its confidence is still usable. */
const AdviceSchema = z.object({
  operation: z.string(),
  confidence: z.number().optional(),
  rationale: z.string().optional(),
});

const ReviewSchema = z.object({
  upheld: z.boolean(),
  reason: z.string().optional(),
});

function clampConfidence(value: number | undefined): number {
  const raw = value ?? UNSTATED_CONFIDENCE;
  if (!Number.isFinite(raw)) {
    return UNSTATED_CONFIDENCE;
  }
  return Math.min(1, Math.max(0, raw));
}

function optional(value: number | undefined): string {
  return value === undefined ? 'unknown' : String(Math.round(value));
}

function describeSnapshot(health: HealthSnapshot): string {
  const degraded = health.degraded.length === 0 ? 'none' : health.degraded.join(', ');
  const floor = health.enrichment.truncated ? ' (the scan was cut, so these are a floor)' : '';
  return [
    `graph: ${String(health.graph.nodes)} nodes, ${String(health.graph.relationships)} relationships, ` +
      `vector parity ${health.graph.vectorParity.toFixed(2)} ` +
      `(${String(health.graph.vectorPresent)} of ${String(health.graph.vectorExpected)}), ` +
      `orphan share ${health.graph.orphanShare.toFixed(2)}, ` +
      `${String(health.graph.episodesWithoutSession)} episodes with no session link, ` +
      `${String(health.graph.staleNarratives)} narratives under an older grounding, ` +
      `${String(health.graph.decayableEdges)} decayable edges`,
    `queue: depth ${String(health.queue.depth)}, ${String(health.queue.exhausted)} exhausted, ` +
      `oldest unclaimed ${optional(health.queue.oldestUnclaimedMs)} ms, ` +
      `${String(health.queue.deadLetterAttentionCount)} needing a person`,
    `enrichment: ${String(health.enrichment.episodes)} episodes, ` +
      `${String(health.enrichment.unenriched)} unenriched, ` +
      `${String(health.enrichment.queued)} queued${floor}`,
    `redaction: ${String(health.redaction.scanned)} scanned, ${String(health.redaction.leaking)} still leaking`,
    `proposals: ${String(health.proposals.supersessionOpen)} supersession open, ` +
      `${String(health.proposals.entityMergeOpen)} entity merge open`,
    `plasticity: reinforcement queue ${String(health.plasticity.reinforcementQueueDepth)}, ` +
      `last decay ${health.plasticity.decayLastRunAt ?? 'never'}`,
    `degraded collectors: ${degraded}`,
  ].join('\n');
}

/** The shared wording for a timing the record does not carry. */
const UNKNOWN_COST = 'cost unknown';

/**
 * What one run of this operation has cost, which is what makes "prefer the cheapest" a question
 * the reading answers rather than a guess from the operation's name.
 */
function describeCost(meanDurationMs: number | undefined): string {
  if (meanDurationMs === undefined) {
    return UNKNOWN_COST;
  }
  return `typically ${(meanDurationMs / 1000).toFixed(1)}s per run`;
}

function describeRecord(stats: OperationEffectiveness | undefined): string {
  if (stats === undefined) {
    return `untried, ${UNKNOWN_COST}`;
  }
  return [
    `${String(stats.runs)} runs`,
    `${String(stats.improved)} improved`,
    `effectiveness ${describeEffectiveness(stats.effectiveness)}`,
    `${String(stats.cyclesSinceSelected)} cycles since it was last selected`,
    describeCost(stats.meanDurationMs),
  ].join(', ');
}

function describeCandidate(candidate: OperationCandidate, health: HealthSnapshot): string {
  const stats = health.effectiveness.find((entry) => entry.name === candidate.name);
  const answers = candidate.answers === undefined ? 'routine' : `answers ${candidate.answers}`;
  return (
    `${candidate.name}: relevance ${candidate.relevance.toFixed(3)}, ` +
    `${answers}, ${describeRecord(stats)}`
  );
}

function buildAdviceMessages(request: Tier3Request): ChatMessage[] {
  return [
    { role: 'system', content: ADVICE_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Health reading:\n${describeSnapshot(request.health)}\n\n` +
        `Operations that could run this cycle:\n` +
        `${request.candidates.map((candidate) => describeCandidate(candidate, request.health)).join('\n')}\n\n` +
        `Why the deterministic tiers selected nothing: ${request.reason}`,
    },
  ];
}

function buildReviewMessages(request: Tier3Request, proposal: Tier3Proposal): ChatMessage[] {
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Health reading:\n${describeSnapshot(request.health)}\n\n` +
        `Operations that could run this cycle:\n` +
        `${request.candidates.map((candidate) => describeCandidate(candidate, request.health)).join('\n')}\n\n` +
        `The recommendation under review: run ${proposal.operation}, because ${proposal.rationale}`,
    },
  ];
}

/**
 * One recommendation, prompt and schema included. The schema restricts the answer to the
 * operations this cycle actually offered, so an operation the loop could not run is a shape
 * the model cannot return rather than a proposal a later gate has to throw away.
 */
export async function adviseTier3(
  provider: Pick<Provider, 'generate'>,
  request: Tier3Request,
  options: Tier3CallOptions,
): Promise<Tier3Outcome> {
  const names = request.candidates.map((candidate) => candidate.name);
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  // Already aborted means the loop is stopping, and a call started now is a call the caller
  // is waiting on for nothing.
  if (deadline.signal.aborted) {
    deadline.clear();
    return { status: 'failed', reason: 'the loop stopped before the call started' };
  }
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildAdviceMessages(request),
      schema: adviceSchema(names),
      temperature: TIER3_TEMPERATURE,
      // The answer is a choice over a table the caller already scored. Reasoning doubles the
      // cost of a call the loop makes on every idle tick and moves nothing.
      think: false,
      signal: deadline.signal,
    });
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  } finally {
    deadline.clear();
  }

  const parsed = AdviceSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'unusable', reason: 'the advisor answered in a shape the schema refuses' };
  }

  // Lowercased before both comparisons: every registered name is snake_case, so a model
  // answering "None" is the decline it means rather than an unusable answer.
  const operation = parsed.data.operation.trim().toLowerCase();
  const stated = parsed.data.rationale?.trim();
  const rationale = stated === undefined || stated.length === 0 ? NO_RATIONALE_GIVEN : stated;
  if (operation === TIER3_NO_OPERATION || operation.length === 0) {
    return { status: 'declined', rationale };
  }
  if (!names.includes(operation)) {
    return {
      status: 'unusable',
      reason: `the advisor named ${operation}, which is not a candidate`,
    };
  }
  return {
    status: 'advised',
    proposal: { operation, confidence: clampConfidence(parsed.data.confidence), rationale },
  };
}

/**
 * `failed` and `unusable` are kept apart from `vetoed` here and counted as vetoes at the call
 * site. A review that never arrived is not a review that agreed.
 */
export type Tier3Review =
  | { readonly status: 'upheld' }
  | { readonly status: 'vetoed'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'unusable'; readonly reason: string };

/**
 * The second pass, arguing the other side of the recommendation. It sees the same reading and
 * the same candidate table, and it is told what was recommended and why, because what it is
 * asked is whether that specific claim survives the evidence.
 */
export async function reviewTier3Proposal(
  provider: Pick<Provider, 'generate'>,
  request: Tier3Request,
  proposal: Tier3Proposal,
  options: Tier3CallOptions,
): Promise<Tier3Review> {
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  if (deadline.signal.aborted) {
    deadline.clear();
    return { status: 'failed', reason: 'the loop stopped before the call started' };
  }
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildReviewMessages(request, proposal),
      schema: REVIEW_JSON_SCHEMA,
      temperature: TIER3_TEMPERATURE,
      think: false,
      signal: deadline.signal,
    });
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  } finally {
    deadline.clear();
  }

  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'unusable', reason: 'the reviewer answered in a shape the schema refuses' };
  }
  if (parsed.data.upheld) {
    return { status: 'upheld' };
  }
  const stated = parsed.data.reason?.trim();
  return {
    status: 'vetoed',
    reason: stated === undefined || stated.length === 0 ? 'the reviewer gave no reason' : stated,
  };
}

export type ModelAdvisorDeps = {
  readonly provider: Pick<Provider, 'generate'>;
  readonly logger: Logger;
  readonly config: Config;
};

/**
 * The advisor the service wires: one call, one structured log line per outcome. Model and
 * timeout come from the injected config rather than from a defaults table, so an environment
 * that overrides either gets the advisor it configured.
 */
export function modelAdvisor(deps: ModelAdvisorDeps): Tier3Advisor {
  return async (request) => {
    const outcome = await adviseTier3(deps.provider, request, {
      model: deps.config.models.reflect,
      timeoutMs: deps.config.reflection.stageTimeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    deps.logger.info(
      {
        reason: request.reason,
        status: outcome.status,
        candidates: request.candidates.length,
        ...(outcome.status === 'advised'
          ? { operation: outcome.proposal.operation, confidence: outcome.proposal.confidence }
          : {}),
        ...(outcome.status === 'declined' ? { rationale: outcome.rationale } : {}),
        ...(outcome.status === 'failed' || outcome.status === 'unusable'
          ? { detail: outcome.reason }
          : {}),
      },
      'introspection tier 3 advisor answered',
    );
    return outcome;
  };
}
