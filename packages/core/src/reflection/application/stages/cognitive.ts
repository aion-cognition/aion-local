import { z } from 'zod';
import {
  COGNITIVE_NODE_LABELS,
  writeCognitiveNode,
  type CognitiveNodeLabel,
  type CognitiveNodeMetadata,
} from '../../../infrastructure/graph/cognitive-queries.js';
import type { ChatMessage, JsonSchema, Vector } from '../../../infrastructure/providers/types.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * Whitepaper §6.7 / Algorithm 4 step 6: one structured-output call per episode extracting
 * the nine cognitive types, each persisted with full bitemporal stamps, a content vector,
 * and `EXTRACTED_FROM` provenance back to the episode. `infrastructure/graph/cognitive-
 * queries.ts` owns the write and the node-identity rule this stage relies on for
 * idempotency; this file owns the model call and the mapping from its output to that write.
 */

/** `config.models.reflect`'s pinned default; the Integration task threads the configured value in. */
export const DEFAULT_COGNITIVE_MODEL = 'qwen3:8b';

/**
 * qwen3:8b with thinking on measured 10-44s with occasional non-returns (binding note).
 * Reflection's latency regime is relaxed, not unbounded, so the call still carries a guard.
 */
export const DEFAULT_COGNITIVE_TIMEOUT_MS = 60_000;

/** Section 6.7's "keep it modest" extends to volume: a bound on one episode's extraction. */
export const DEFAULT_MAX_COGNITIVE_NODES = 20;

export type CognitiveExtractionStageOptions = {
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxNodes?: number;
};

const NODE_TYPES = COGNITIVE_NODE_LABELS;

const COGNITIVE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: NODE_TYPES },
          text: { type: 'string' },
          status: { type: 'string' },
          priority: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['type', 'text'],
      },
    },
  },
  required: ['nodes'],
};

const ExtractedNodeSchema = z.object({
  type: z.enum(NODE_TYPES),
  text: z.string().min(1),
  status: z.string().optional(),
  priority: z.string().optional(),
  rationale: z.string().optional(),
});

type ExtractedNode = z.infer<typeof ExtractedNodeSchema>;

const CognitiveExtractionOutputSchema = z.object({
  nodes: z.array(ExtractedNodeSchema),
});

const SYSTEM_PROMPT = [
  'You extract cognitive structure from a memory episode recorded by an AI coding agent:',
  'goals, plans, decisions, insights, concepts, contexts, events, patterns, and trends the episode actually contains.',
  'Give each node a type from that list and a one-sentence text grounded in the episode.',
  'For a goal, add status (active, completed, or abandoned) and priority (low, medium, or high) when the episode states them.',
  'For a plan, add status (active, completed, or abandoned) when the episode states it.',
  'For a decision, add a one-sentence rationale when the episode gives one.',
  'Skip a type with no evidence in the episode; do not pad the output to cover every type.',
].join(' ');

function buildMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Episode:\n${text}` },
  ];
}

/** Section 6.7's per-type fields; every other type carries `text` alone. */
function metadataFor(node: ExtractedNode): CognitiveNodeMetadata {
  if (node.type === 'Goal') {
    return { status: node.status, priority: node.priority };
  }
  if (node.type === 'Plan') {
    return { status: node.status };
  }
  if (node.type === 'Decision') {
    return { rationale: node.rationale };
  }
  return {};
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class CognitiveExtractionStage implements ReflectionStage {
  readonly name = 'cognitive';
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxNodes: number;

  constructor(options: CognitiveExtractionStageOptions = {}) {
    this.#model = options.model ?? DEFAULT_COGNITIVE_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_COGNITIVE_TIMEOUT_MS;
    this.#maxNodes = options.maxNodes ?? DEFAULT_MAX_COGNITIVE_NODES;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const text = ctx.episode.text.trim();
    if (text.length === 0) {
      return { status: 'skipped', summary: 'episode has no text to extract from' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let raw: unknown;
    try {
      raw = await ctx.provider.generate({
        model: this.#model,
        messages: buildMessages(text),
        schema: COGNITIVE_JSON_SCHEMA,
        // Reasoning buys nothing for extraction and costs the budget (mirrors cues.ts / the quality harness).
        think: false,
        signal: controller.signal,
      });
    } catch (error) {
      return {
        status: 'failed',
        summary: `cognitive extraction call ${isAbortError(error) ? 'timed out' : 'failed'}: ${describeError(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    const parsed = CognitiveExtractionOutputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 'failed',
        summary: `cognitive extraction returned an invalid shape: ${formatZodError(parsed.error)}`,
      };
    }

    const nodes = parsed.data.nodes
      .slice(0, this.#maxNodes)
      .filter((node) => node.text.trim().length > 0);
    if (nodes.length === 0) {
      return { status: 'skipped', summary: 'no cognitive structure found in the episode' };
    }

    // Absent vectors leave the written nodes as pending-vector `:Memory` markers rather than
    // failing the stage: `reflection/application/vectors.ts`'s backfill already drains them.
    let vectors: readonly Vector[] = [];
    try {
      vectors = await ctx.provider.embed(nodes.map((node) => node.text));
    } catch (error) {
      ctx.logger.warn(
        { err: error, episodeId: ctx.episodeId },
        'cognitive extraction: embedding failed, writing nodes without content vectors',
      );
    }

    let written = 0;
    let created = 0;
    let writeError: unknown;
    for (const [index, node] of nodes.entries()) {
      try {
        const result = await writeCognitiveNode(ctx.driver, {
          episodeId: ctx.episodeId,
          label: node.type as CognitiveNodeLabel,
          text: node.text.trim(),
          metadata: metadataFor(node),
          contentVector: vectors[index],
          occurredAt: ctx.episode.occurredAt,
          now: ctx.now,
        });
        written += 1;
        if (result.created) {
          created += 1;
        }
      } catch (error) {
        writeError = error;
        break;
      }
    }

    if (writeError !== undefined) {
      return {
        status: 'failed',
        summary: `cognitive extraction wrote ${written} of ${nodes.length} node(s) before a graph write failed: ${describeError(writeError)}`,
        ...(written > 0 ? { counts: { cognitive: written } } : {}),
      };
    }

    return {
      status: 'ok',
      summary: `extracted ${nodes.length} cognitive node(s), ${created} new`,
      counts: { cognitive: nodes.length },
    };
  }
}
