import { z } from 'zod';

import {
  narrowClaimKey,
  resolveClaimSubjects,
  storedClaimKey,
  type ClaimSubjects,
  type ExtractedClaimKey,
} from './subject-resolution.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { describeError, formatZodError, isAbortError } from '../../../infrastructure/errors.js';
import type { KeyedCloseMode } from '../../../infrastructure/graph/claim-key-queries.js';
import {
  COGNITIVE_NODE_LABELS,
  writeCognitiveNode,
  type CognitiveNodeMetadata,
} from '../../../infrastructure/graph/cognitive-queries.js';
import type { ChatMessage, JsonSchema, Vector } from '../../../infrastructure/providers/types.js';
import { TEMPORAL_CLASSES } from '../../domain/claim-key.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * One structured-output call per episode extracting the nine cognitive types, each persisted
 * with full bitemporal stamps, a content vector, and `EXTRACTED_FROM` provenance back to the
 * episode. `infrastructure/graph/cognitive-queries.ts` owns the write and the node-identity
 * rule this stage relies on for idempotency; this file owns the model call and the mapping
 * from its output to that write.
 *
 * A fact-bearing claim also carries the key it asserts under: which entity, which attribute, and
 * how long the claim answers for. `subject-resolution.ts` owns what the model said about that
 * key and which entity its subject is.
 */

/** The pinned `AION_KEYED_CLOSE_MODE`, which decides whether a claim is keyed at all. */
export const DEFAULT_KEYED_CLOSE_MODE: KeyedCloseMode = DEFAULTS.reflection.keyedCloseMode;

export type CognitiveExtractionStageOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxNodes: number;
  /** `off` resolves no subject and stores no key, which is what makes it the kill switch. */
  readonly keyedCloseMode: KeyedCloseMode;
  /** How close a sibling has to be before a keyed close takes it with the claim it closes. */
  readonly familyRelatednessFloor: number;
  readonly readingHorizonDays: number;
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
          subject_entity: { type: 'string' },
          aspect: { type: 'string' },
          temporal_class: { type: 'string', enum: [...TEMPORAL_CLASSES] },
        },
        // The key fields stay out of `required`: most claims name no subject the graph holds,
        // and forcing three fields onto every node buys a key the episode did not state.
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
  // Unknown rather than typed, the way entity extraction reads `aliases` and `is_speaker`: a
  // model that invents a fourth temporal class is wrong about one field, and rejecting the node
  // over it would throw away a claim the episode really made. The narrowing is what decides.
  subject_entity: z.unknown().optional(),
  aspect: z.unknown().optional(),
  temporal_class: z.unknown().optional(),
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
  'is the normal and expected outcome: do not add a node merely to cover a type, and do not',
  'add a second node restating one you already extracted under a different type.',
  'Give each node a type from that list and a one-sentence text grounded in the episode.',
  'Those nine are the only types that exist; a node whose type is not one of them is discarded,',
  'so record what would have been a tenth type under whichever of the nine fits it best.',
  'For a goal, add status (active, completed, or abandoned) and priority (low, medium, or high) when the episode states them.',
  'For a plan, add status (active, completed, or abandoned) when the episode states it.',
  'For a decision, add a one-sentence rationale when the episode gives one.',
  "A goal or plan must state something beyond the episode's own summary line; if it would",
  'only restate that summary in different words, leave it out.',
  'For a decision, insight, concept, or event only, add three more fields when the episode',
  'makes them plain: subject_entity, the one thing the claim asserts about, spelled the way the',
  'episode spells it; aspect, the attribute of that thing being asserted, never its value, so',
  '"supersede mode" and not "unanimous", and "retry limit" and not "five"; and temporal_class,',
  'which is reading for a measurement that goes stale on its own, standing for something that',
  'holds until it is corrected, and trend for a direction rather than a value.',
  'Leaving all three out is normal and expected: give them for a claim that states one attribute',
  'of one named thing, and omit them for everything else.',
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
  'duplicate remittance investigation", that candidate is a restatement. Completing the same',
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
      restated: {
        type: 'array',
        items: { type: 'string', enum: candidates.map((candidate) => candidate.key) },
      },
    },
    required: ['restated'],
  };
}

function buildRestatementMessages(
  summary: string,
  candidates: readonly RestatementCandidate[],
): ChatMessage[] {
  const items = candidates
    .map((candidate) => `${candidate.key} [${candidate.type}]: ${candidate.text}`)
    .join('\n');
  return [
    { role: 'system', content: RESTATEMENT_SYSTEM_PROMPT },
    { role: 'user', content: `Episode summary:\n${summary}\n\nCandidates:\n${items}` },
  ];
}

const RestatementOutputSchema = z.object({ restated: z.array(z.string()) });

export class CognitiveExtractionStage implements ReflectionStage {
  readonly name = 'cognitive';
  readonly #options: CognitiveExtractionStageOptions;

  constructor(options: Partial<CognitiveExtractionStageOptions> = {}) {
    this.#options = {
      model: DEFAULTS.models.reflect,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      maxNodes: DEFAULTS.reflection.maxCognitiveNodes,
      keyedCloseMode: DEFAULT_KEYED_CLOSE_MODE,
      familyRelatednessFloor: DEFAULTS.reflection.supersedeFamilyRelatednessFloor,
      readingHorizonDays: DEFAULTS.temporal.readingHorizonDays,
      ...options,
    };
  }

  /**
   * The options this instance actually runs on. `keyedCloseMode` is the kill switch and reaches
   * the stage only through construction, so without a reader a build that dropped the wiring goes
   * on keying and closing under a deployment that set `off`, with the constructor default
   * answering for the config.
   */
  describe(): CognitiveExtractionStageOptions {
    return this.#options;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const text = ctx.episode.text.trim();
    if (text.length === 0) {
      return { status: 'skipped', summary: 'episode has no text to extract from' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#options.timeoutMs);
    let raw: unknown;
    try {
      raw = await ctx.provider.generate({
        model: this.#options.model,
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
      .slice(0, this.#options.maxNodes)
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
      // Trimmed, because the trimmed form is what the node stores and what its vector hash is
      // taken over; embedding the raw wording would stamp a hash for text nothing holds.
      vectors = await ctx.provider.embed(nodes.map((node) => node.text.trim()));
    } catch (error) {
      ctx.logger.warn(
        { err: error, episodeId: ctx.episodeId },
        'cognitive extraction: embedding failed, writing nodes without content vectors',
      );
    }

    const keys = nodes.map((node) =>
      narrowClaimKey(node.type, {
        subjectEntity: node.subject_entity,
        aspect: node.aspect,
        temporalClass: node.temporal_class,
      }),
    );
    const subjects = await this.#resolveSubjects(ctx, keys);

    let written = 0;
    let created = 0;
    let closed = 0;
    let writeError: unknown;
    for (const [index, node] of nodes.entries()) {
      try {
        const result = await writeCognitiveNode(ctx.driver, {
          episodeId: ctx.episodeId,
          label: node.type,
          text: node.text.trim(),
          metadata: metadataFor(node),
          contentVector: vectors[index],
          occurredAt: ctx.occurredAt,
          now: ctx.now,
          ...storedClaimKey(keys[index] ?? {}, subjects),
          readingHorizonDays: this.#options.readingHorizonDays,
          keyedClose: {
            mode: this.#options.keyedCloseMode,
            relatednessFloor: this.#options.familyRelatednessFloor,
          },
        });
        written += 1;
        closed += result.keyedClose?.closedIds.length ?? 0;
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

    const closing = closed === 0 ? '' : `, ${closed} closed by key`;
    return {
      status: 'ok',
      summary: `extracted ${nodes.length} cognitive node(s), ${created} new${closing}`,
      counts: { cognitive: nodes.length },
    };
  }

  /**
   * The subjects this run's keys resolve to, or none of them. A failed identity read costs the
   * episode its keys and nothing else: the claims are what the episode paid for, and an unkeyed
   * claim still reaches the judge that has always handled it.
   */
  async #resolveSubjects(
    ctx: StageContext,
    keys: readonly ExtractedClaimKey[],
  ): Promise<ClaimSubjects> {
    if (this.#options.keyedCloseMode === 'off') {
      return new Map();
    }
    try {
      return await resolveClaimSubjects(ctx, keys);
    } catch (error) {
      ctx.logger.warn(
        { err: error, episodeId: ctx.episodeId },
        'cognitive extraction: subject resolution failed, writing the claims without keys',
      );
      return new Map();
    }
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
        candidates.push({
          key: `R${candidates.length + 1}`,
          nodeIndex,
          type: node.type,
          text: node.text,
        });
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
      candidates
        .filter((candidate) => restatedKeys.has(candidate.key))
        .map((candidate) => candidate.nodeIndex),
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
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#options.timeoutMs);
    try {
      const raw = await ctx.provider.generate({
        model: this.#options.model,
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
