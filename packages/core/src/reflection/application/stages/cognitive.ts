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
 * One structured-output call per episode extracting the nine cognitive types, each persisted
 * with full bitemporal stamps, a content vector, and `EXTRACTED_FROM` provenance back to the
 * episode. `infrastructure/graph/cognitive-queries.ts` owns the write and the node-identity
 * rule this stage relies on for idempotency; this file owns the model call and the mapping
 * from its output to that write.
 */

/** `config.models.reflect`'s default; callers thread the configured value in. */
export const DEFAULT_COGNITIVE_MODEL = 'qwen3:8b';

/**
 * qwen3:8b with thinking on measured 10-44s with occasional non-returns. Reflection's
 * latency regime is relaxed, not unbounded, so the call still carries a guard.
 */
export const DEFAULT_COGNITIVE_TIMEOUT_MS = 60_000;

/** A bound on one episode's extraction: the volume stays modest. */
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

/**
 * The list is validated per node, not as a whole. A model that invents a tenth type for one
 * node ("Problem" is the one seen most) otherwise costs the episode every node it got right,
 * which measured as no cognitive structure at all on a route that had extracted a clean
 * Decision beside the bad entry. An unusable node is dropped and counted; a reply that is not
 * a list of objects at all is still a failed extraction.
 */
const CognitiveExtractionOutputSchema = z.object({
  nodes: z.array(z.unknown()),
});

type UsableNodes = {
  readonly nodes: readonly ExtractedNode[];
  readonly dropped: number;
};

function usableNodes(raw: readonly unknown[]): UsableNodes {
  const nodes: ExtractedNode[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const parsed = ExtractedNodeSchema.safeParse(entry);
    if (parsed.success) {
      nodes.push(parsed.data);
      continue;
    }
    dropped += 1;
  }
  return { nodes, dropped };
}

const SYSTEM_PROMPT = [
  'You extract cognitive structure from a memory episode recorded by an AI coding agent:',
  'goals, plans, decisions, insights, concepts, contexts, events, patterns, and trends the episode actually contains.',
  'Most episodes do not contain all nine kinds, and many contain only one or two of them.',
  'Extract a type only when the episode gives it real, distinct content; return nothing at',
  'all for a type the episode has no content for. Returning fewer than nine nodes, or zero,',
  'is the normal and expected outcome — do not add a node merely to cover a type, and do not',
  'add a second node restating one you already extracted under a different type.',
  'Give each node a type from that list and a one-sentence text grounded in the episode.',
  'Those nine are the only types that exist; a node whose type is not one of them is discarded,',
  'so record what would have been a tenth type under whichever of the nine fits it best.',
  'For a goal, add status (active, completed, or abandoned) and priority (low, medium, or high) when the episode states them.',
  'For a plan, add status (active, completed, or abandoned) when the episode states it.',
  'For a decision, add a one-sentence rationale when the episode gives one.',
  'A goal or plan must state something beyond the episode\'s own summary line; if it would',
  'only restate that summary in different words, leave it out.',
].join(' ');

function buildMessages(text: string, summary: string | undefined): ChatMessage[] {
  const summaryLine =
    summary === undefined || summary.length === 0
      ? ''
      : `\n\nEpisode summary (for the goal/plan restatement check only, not a source to extract from):\n${summary}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Episode:\n${text}${summaryLine}` },
  ];
}

/** The per-type fields; every other type carries `text` alone. */
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

/**
 * A second, independent judgment on exactly the Goal and Plan candidates the first call
 * proposed: does this state something the episode's own summary does not already say? The
 * in-prompt instruction on the first call is the primary defense; this call exists because
 * an instruction alone measurably did not stop the padding it asked the model not to do.
 * Whether a candidate survives is still the model's call, never a text comparison here,
 * just asked a second time, on a narrower question, with a chance to reconsider.
 */
const RESTATEMENT_SYSTEM_PROMPT = [
  "You check candidate Goal and Plan nodes extracted from one episode against that episode's",
  'own summary line, looking for restatements to drop. A candidate is a restatement when it',
  'says the same thing the summary already says, even in different words or as a completed',
  'goal instead of a summary sentence.',
  'Example: the summary is "closed out the duplicate remittance investigation" and a',
  'candidate Goal reads "Close the duplicate remittance investigation" or "Close out the',
  'duplicate remittance investigation" — that candidate is a restatement. Completing the same',
  'thing the summary already says was completed adds no information, no matter how the goal',
  'text words it.',
  'Return the keys of every candidate that is a restatement by this test; return an empty',
  'list only when none of them are.',
].join(' ');

type RestatementCandidate = {
  readonly key: string;
  readonly nodeIndex: number;
  readonly type: 'Goal' | 'Plan';
  readonly text: string;
};

function buildRestatementSchema(candidates: readonly RestatementCandidate[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      restated: { type: 'array', items: { type: 'string', enum: candidates.map((candidate) => candidate.key) } },
    },
    required: ['restated'],
  };
}

function buildRestatementMessages(summary: string, candidates: readonly RestatementCandidate[]): ChatMessage[] {
  const items = candidates.map((candidate) => `${candidate.key} [${candidate.type}]: ${candidate.text}`).join('\n');
  return [
    { role: 'system', content: RESTATEMENT_SYSTEM_PROMPT },
    { role: 'user', content: `Episode summary:\n${summary}\n\nCandidates:\n${items}` },
  ];
}

const RestatementOutputSchema = z.object({ restated: z.array(z.string()) });

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
        messages: buildMessages(text, ctx.episode.summary),
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

    const usable = usableNodes(parsed.data.nodes);
    if (usable.dropped > 0) {
      ctx.logger.warn(
        { episodeId: ctx.episodeId, dropped: usable.dropped, kept: usable.nodes.length },
        'cognitive extraction: dropped node(s) the schema does not describe',
      );
    }
    const extracted = usable.nodes
      .slice(0, this.#maxNodes)
      .filter((node) => node.text.trim().length > 0);
    if (extracted.length === 0) {
      if (usable.dropped > 0) {
        return {
          status: 'failed',
          summary: `cognitive extraction returned ${usable.dropped} node(s), none of them a described type`,
        };
      }
      return { status: 'skipped', summary: 'no cognitive structure found in the episode' };
    }

    const summary = ctx.episode.summary?.trim();
    const nodes =
      summary === undefined || summary.length === 0
        ? extracted
        : await this.#dropRestatements(ctx, extracted, summary);
    if (nodes.length === 0) {
      return {
        status: 'ok',
        summary: 'every extracted node restated the episode summary and was dropped',
        counts: { cognitive: 0 },
      };
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

  /** Keeps every non-Goal/Plan node untouched; Goal/Plan candidates pass through validation. */
  async #dropRestatements(
    ctx: StageContext,
    nodes: readonly ExtractedNode[],
    summary: string,
  ): Promise<readonly ExtractedNode[]> {
    const candidates: RestatementCandidate[] = [];
    nodes.forEach((node, nodeIndex) => {
      if (node.type === 'Goal' || node.type === 'Plan') {
        candidates.push({ key: `R${candidates.length + 1}`, nodeIndex, type: node.type, text: node.text });
      }
    });
    if (candidates.length === 0) {
      return nodes;
    }

    const restated = await this.#validateRestatements(ctx, summary, candidates);
    if (restated === undefined) {
      ctx.logger.warn(
        { episodeId: ctx.episodeId, candidates: candidates.length },
        'cognitive extraction: restatement validation unusable twice, dropping the candidate goal/plan node(s)',
      );
      const dropped = new Set(candidates.map((candidate) => candidate.nodeIndex));
      return nodes.filter((_, index) => !dropped.has(index));
    }

    const restatedKeys = new Set(restated);
    const dropped = new Set(
      candidates.filter((candidate) => restatedKeys.has(candidate.key)).map((candidate) => candidate.nodeIndex),
    );
    return nodes.filter((_, index) => !dropped.has(index));
  }

  /** One call, then one retry of the same question on an unusable answer; `undefined` on both. */
  async #validateRestatements(
    ctx: StageContext,
    summary: string,
    candidates: readonly RestatementCandidate[],
  ): Promise<readonly string[] | undefined> {
    const first = await this.#restatementCall(ctx, summary, candidates);
    return first ?? this.#restatementCall(ctx, summary, candidates);
  }

  async #restatementCall(
    ctx: StageContext,
    summary: string,
    candidates: readonly RestatementCandidate[],
  ): Promise<readonly string[] | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const raw = await ctx.provider.generate({
        model: this.#model,
        messages: buildRestatementMessages(summary, candidates),
        schema: buildRestatementSchema(candidates),
        think: false,
        signal: controller.signal,
      });
      const parsed = RestatementOutputSchema.safeParse(raw);
      return parsed.success ? parsed.data.restated : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
