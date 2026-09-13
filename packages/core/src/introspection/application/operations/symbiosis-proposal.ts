import { z } from 'zod';

import type { CommunityMember } from '../../../infrastructure/graph/community-queries.js';
import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Provider } from '../../../infrastructure/providers/types.js';
import { LOCAL as SYSTEM_PROMPT } from '../../../prompts/symbiosis-bridge.js';
import type { CommunityPairScore } from '../../domain/bridge-pairs.js';

/**
 * The model stage of the bridge: it is handed a profile of each community and answers with the
 * relation it found, or declines.
 *
 * What it is asked is the whole question. It chooses which two members the relation runs
 * between, what each contributes, what the relation is, what it rests on, and how well the two
 * go together. It used to be given two nodes the cosine had already picked and asked only for a
 * caption, which made the model the last stage of a deterministic pipeline rather than the one
 * doing the joining.
 *
 * A decline is an answer. It is kept apart from a call that failed, because one says the
 * substrate has nothing worth bridging here and the other says nobody asked.
 */

/** The answer's own shape, so a decline is a value the schema can carry rather than a parse failure. */
export const BRIDGE_DECISIONS = ['bridge', 'decline'] as const;

const BRIDGE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: [...BRIDGE_DECISIONS] },
    sourceId: { type: 'string' },
    targetId: { type: 'string' },
    sourceRole: { type: 'string' },
    targetRole: { type: 'string' },
    summary: { type: 'string' },
    rationale: { type: 'string' },
    premises: { type: 'array', items: { type: 'string' } },
    compatibility: { type: 'number' },
  },
  required: ['decision', 'summary', 'rationale', 'compatibility'],
};

/** Looser than the JSON schema: an answer missing a role or its premises is still usable. */
const AnswerSchema = z.object({
  decision: z.string(),
  sourceId: z.string().optional(),
  targetId: z.string().optional(),
  sourceRole: z.string().optional(),
  targetRole: z.string().optional(),
  summary: z.string(),
  rationale: z.string(),
  premises: z.array(z.string()).optional(),
  compatibility: z.number(),
});

const BRIDGE_MAX_TOKENS = 4096;

/** One pair reads one way: the text goes onto an edge the graph keeps. */
const BRIDGE_TEMPERATURE = 0;

export type BridgeProposal = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceRole: string;
  readonly targetRole: string;
  readonly summary: string;
  readonly rationale: string;
  readonly premises: readonly string[];
  readonly compatibility: number;
};

/**
 * `declined` is the model's own answer and controls the run. `failed` and `unusable` are the
 * call not arriving, which is the only thing the deterministic floor is for.
 */
export type BridgeAnswer =
  | { readonly status: 'proposed'; readonly proposal: BridgeProposal }
  | { readonly status: 'declined'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'unusable'; readonly reason: string };

export type CommunityContext = {
  readonly pair: CommunityPairScore;
  readonly leftMembers: readonly CommunityMember[];
  readonly rightMembers: readonly CommunityMember[];
};

export type BridgeCallOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

function describeMembers(members: readonly CommunityMember[]): string {
  return members.map((member) => `- ${member.id}: ${member.label}`).join('\n');
}

function describeCluster(
  name: string,
  size: number,
  coherence: number,
  members: readonly CommunityMember[],
): string {
  return (
    `Cluster ${name}: ${String(size)} memories, coherence ${coherence.toFixed(2)}, ` +
    `${String(members.length)} of them listed\n${describeMembers(members)}`
  );
}

export function buildBridgeMessages(context: CommunityContext): ChatMessage[] {
  const { pair } = context;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `${describeCluster('A', pair.left.size, pair.coherence, context.leftMembers)}\n\n` +
        `${describeCluster('B', pair.right.size, pair.coherence, context.rightMembers)}\n\n` +
        `No association edge crosses between these two clusters.`,
    },
  ];
}

function clean(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}

/**
 * One proposal, prompt and schema included. Endpoint ids are checked against the lists the call
 * offered: an id from neither list is an answer about nodes the model was not shown, and a
 * bridge anchored on one would be a relation between something and nothing.
 */
export async function proposeBridge(
  provider: Pick<Provider, 'generate'>,
  context: CommunityContext,
  options: BridgeCallOptions,
): Promise<BridgeAnswer> {
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  if (deadline.signal.aborted) {
    deadline.clear();
    return { status: 'failed', reason: 'the loop stopped before the call started' };
  }
  let raw: unknown;
  try {
    raw = await provider.generate({
      surface: 'symbiosis_bridge',
      model: options.model,
      messages: buildBridgeMessages(context),
      schema: BRIDGE_JSON_SCHEMA,
      maxTokens: BRIDGE_MAX_TOKENS,
      temperature: BRIDGE_TEMPERATURE,
      // The answer is a relation the model has to find across two lists of memories, which is
      // the reasoning this operation exists for.
      think: true,
      signal: deadline.signal,
    });
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    deadline.clear();
  }

  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'unusable', reason: 'the answer is a shape the schema refuses' };
  }
  const answer = parsed.data;
  const rationale = clean(answer.rationale);

  // Read before the endpoints are looked at: a decline names no members, and treating a
  // missing id as a broken answer would turn every refusal into a fallback bridge.
  if (clean(answer.decision).toLowerCase() !== 'bridge') {
    return {
      status: 'declined',
      reason: rationale.length === 0 ? 'the answer gave no reason' : rationale,
    };
  }

  const sourceId = clean(answer.sourceId);
  const targetId = clean(answer.targetId);
  const offeredLeft = context.leftMembers.some((member) => member.id === sourceId);
  const offeredRight = context.rightMembers.some((member) => member.id === targetId);
  if (!offeredLeft || !offeredRight) {
    return {
      status: 'unusable',
      reason: 'the answer named an endpoint outside the members it was given',
    };
  }

  const summary = clean(answer.summary);
  if (summary.length === 0 || rationale.length === 0) {
    return { status: 'unusable', reason: 'the answer carried no summary or no rationale' };
  }

  return {
    status: 'proposed',
    proposal: {
      sourceId,
      targetId,
      sourceRole: clean(answer.sourceRole),
      targetRole: clean(answer.targetRole),
      summary,
      rationale,
      premises: (answer.premises ?? []).map((premise) => premise.trim()).filter(Boolean),
      compatibility: answer.compatibility,
    },
  };
}
