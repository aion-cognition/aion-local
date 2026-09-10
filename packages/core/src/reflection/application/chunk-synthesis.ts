import type { Driver } from 'neo4j-driver';

import { deadlineFor } from '../../infrastructure/providers/deadline-signal.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import {
  renderSealedChunk,
  type ChunkEnrichmentNode,
  type ChunkRender,
} from '../domain/chunk-render.js';
import type { ChunkInputPlan, CoverageGap } from '../domain/chunk-revision.js';
import {
  assembleNarrative,
  buildNarrativeMessages,
  narrativeMaxTokens,
  NARRATIVE_JSON_SCHEMA,
  NarrativeOutputSchema,
  type GroundedNarrative,
} from '../domain/narrative.js';

/**
 * The model call a sealed chunk's revision is written by, and the exact record of its input.
 *
 * The whole-session path sizes itself off the route and clips what does not fit. This one does
 * not: the plan has already decided what may be submitted, the render has already measured it,
 * and what reaches the provider is that string. Grounding runs against the same render, so a
 * sentence can only cite something the model was actually handed.
 */

/** Reflection reads closed material and checks its own answer; a sample of it is not the answer. */
const CHUNK_TEMPERATURE = 0;

export type ChunkSynthesisDeps = {
  readonly provider: Provider;
  /**
   * Accepted and unread. Synthesis used to go to the graph for optional context of its own; the
   * caller resolves and fences that now, so the only thing this step needs is the provider. The
   * field stays because every caller holds a driver and passing one is not an error.
   */
  readonly driver?: Driver;
};

export type ChunkSynthesisInput = {
  readonly sessionId: string;
  readonly plan: Extract<ChunkInputPlan, { status: 'render' }>;
  /**
   * Extracted nodes the caller resolved and fenced. Absent, this render carries none: synthesis
   * does not go looking for optional context it has no dependency for.
   */
  readonly enrichment?: readonly ChunkEnrichmentNode[];
  readonly allowance: number;
  readonly now: Date;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxSentences?: number;
  readonly signal?: AbortSignal;
};

export type ChunkCitation = {
  readonly targetId: string;
  readonly targetKind: 'source' | 'part' | 'retained_node';
};

export type ChunkSynthesis = {
  readonly render: ChunkRender;
  readonly output: GroundedNarrative;
  readonly citations: readonly ChunkCitation[];
  /** The plan's gaps, with the oversized one carrying the ranges the render actually submitted. */
  readonly gaps: readonly CoverageGap[];
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'qwen3:8b';

/** The gap the render's own selection proves, rather than the one the plan guessed at. */
function gapsWithRanges(
  plan: ChunkSynthesisInput['plan'],
  render: ChunkRender,
): readonly CoverageGap[] {
  return plan.gaps.map((gap) =>
    gap.reason === 'oversized_member' ? { ...gap, submitted: render.submitted } : gap,
  );
}

/**
 * A render nobody may send: it carries no raw passage, or it is over the bound it was chosen
 * inside. Both are refusals rather than a smaller call, and both are decided before a model is
 * asked anything.
 */
export class ChunkInputRefused extends Error {
  readonly reason: 'no_admitted_raw_passage' | 'rendered_input_over_allowance';

  constructor(reason: ChunkInputRefused['reason'], detail: string) {
    super(`chunk input refused: ${reason}, ${detail}`);
    this.name = 'ChunkInputRefused';
    this.reason = reason;
  }
}

export async function synthesizeChunk(
  deps: ChunkSynthesisDeps,
  input: ChunkSynthesisInput,
): Promise<ChunkSynthesis> {
  const members = [...input.plan.members, ...input.plan.transition];
  const render = renderSealedChunk({
    members,
    enrichment: input.enrichment ?? [],
    allowance: input.allowance,
    ...(input.maxSentences === undefined ? {} : { maxSentences: input.maxSentences }),
    ...(input.plan.boundedPartialOf === undefined
      ? {}
      : { boundedPartialOf: input.plan.boundedPartialOf }),
    ...(input.plan.boundedPartialAllowance === undefined
      ? {}
      : { boundedPartialAllowance: input.plan.boundedPartialAllowance }),
  });

  // The bound is enforced on the string that would be sent, not on the plan that chose it. A
  // render over the allowance and a render carrying no raw passage are both answers this cut
  // refuses to buy: generation happens after these, or not at all.
  if (render.source.items.every((item) => item.text.length === 0)) {
    throw new ChunkInputRefused(
      'no_admitted_raw_passage',
      `${String(members.length)} member(s) rendered to nothing inside ${String(input.allowance)} units`,
    );
  }
  if (render.renderedUnits > input.allowance) {
    throw new ChunkInputRefused(
      'rendered_input_over_allowance',
      `${String(render.renderedUnits)} rendered units exceed ${String(input.allowance)}`,
    );
  }

  const deadline = deadlineFor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, input.signal);
  let raw: unknown;
  try {
    raw = await deps.provider.generate({
      surface: 'narrative_synthesis',
      model: input.model ?? DEFAULT_MODEL,
      messages: buildNarrativeMessages(render.source),
      schema: NARRATIVE_JSON_SCHEMA,
      maxTokens: narrativeMaxTokens(render.source.sentenceBudget),
      temperature: CHUNK_TEMPERATURE,
      think: false,
      signal: deadline.signal,
    });
  } finally {
    deadline.clear();
  }

  const output = assembleNarrative(NarrativeOutputSchema.parse(raw), render.source);
  const sources = new Set(members.map((member) => member.sourceId));
  return {
    render,
    output,
    citations: output.citations.map((targetId) => ({
      targetId,
      targetKind: sources.has(targetId) ? ('source' as const) : ('retained_node' as const),
    })),
    gaps: gapsWithRanges(input.plan, render),
  };
}
