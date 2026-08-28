import { createHash } from 'node:crypto';
import type { Cue, CueSource, CueWeight, Degradation, RecallTurn } from '@aion/protocol';
import { z } from 'zod';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { ChatMessage, JsonSchema, Provider } from '../../infrastructure/providers/types.js';

/**
 * Whitepaper Algorithm 1, minus the keyword fallback this build deletes by design
 * (PRD §6.1). Exactly one `generate` call per invocation (provider hot-path rule, PRD
 * §10); a failure, a busted budget, or a response that fails validation degrades to the
 * caller's own query and summary text verbatim, never to lexical extraction over it.
 */

export type CueExtractionInput = {
  readonly query: string;
  readonly summary?: string;
  readonly recentTurns?: readonly RecallTurn[];
};

export type CueExtractionDeps = {
  readonly provider: Provider;
  /** `config.models.cue`. */
  readonly model: string;
  /** `config.recall.cueBudgetMs`; a hang guard on the one `generate` call, not a target. */
  readonly budgetMs: number;
  /** Constructed once per process and threaded through, like `SessionManager`. */
  readonly cache: CueCache;
  readonly logger: Logger;
};

export type CueExtractionResult = {
  readonly cues: readonly Cue[];
  readonly degraded: boolean;
  /** Present only when `degraded`; carries the reason into `MemoryPackMetadata.degraded` verbatim. */
  readonly degradation?: Degradation;
};

const DEFAULT_CACHE_MAX_ENTRIES = 256;

/**
 * FIFO-bounded cache for one process's cue calls, keyed on the exact input the model saw.
 * Only successful extractions are cached: caching a timeout or a malformed response would
 * freeze recall onto the degraded path for that input until the entry aged out, which
 * defeats the point of the ladder being a per-call fallback.
 */
export class CueCache {
  readonly #entries = new Map<string, CueExtractionResult>();
  readonly #maxEntries: number;

  constructor(maxEntries: number = DEFAULT_CACHE_MAX_ENTRIES) {
    this.#maxEntries = maxEntries;
  }

  get(key: string): CueExtractionResult | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: CueExtractionResult): void {
    if (!this.#entries.has(key) && this.#entries.size >= this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.#entries.delete(oldestKey);
      }
    }
    this.#entries.set(key, value);
  }

  get size(): number {
    return this.#entries.size;
  }
}

const CUE_MODEL_TEMPERATURE = 0.2;

const CUE_OUTPUT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query_cues: { type: 'array', items: { type: 'string' } },
    summary_cues: { type: 'array', items: { type: 'string' } },
    recent_turn_cues: { type: 'array', items: { type: 'string' } },
  },
  required: ['query_cues', 'summary_cues', 'recent_turn_cues'],
};

const CueModelOutputSchema = z.object({
  query_cues: z.array(z.string()),
  summary_cues: z.array(z.string()),
  recent_turn_cues: z.array(z.string()),
});

const CUE_SYSTEM_PROMPT =
  'You extract short semantic search cues from an AI agent memory-recall query. ' +
  'A cue is a concept, entity, or theme worth searching a memory graph for, not ' +
  'necessarily an exact word from the input. The user message has three sections: ' +
  'the query, the conversation summary, and the recent turns. Extract cues separately ' +
  'for each section. Return an empty array for a section marked "(none provided)". ' +
  'Do not invent a cue that needs information outside the section it comes from. Keep ' +
  'each cue to a few words and do not repeat one within its own section.';

function hasSummary(input: CueExtractionInput): boolean {
  return input.summary !== undefined && input.summary.trim().length > 0;
}

function hasRecentTurns(input: CueExtractionInput): boolean {
  return input.recentTurns !== undefined && input.recentTurns.length > 0;
}

function buildMessages(input: CueExtractionInput): ChatMessage[] {
  const sections = [`Query:\n${input.query.trim()}`];

  sections.push(
    hasSummary(input)
      ? `Conversation summary:\n${(input.summary as string).trim()}`
      : 'Conversation summary:\n(none provided)',
  );

  sections.push(
    hasRecentTurns(input)
      ? `Recent turns:\n${(input.recentTurns as readonly RecallTurn[])
          .map((turn) => `${turn.role}: ${turn.text}`)
          .join('\n')}`
      : 'Recent turns:\n(none provided)',
  );

  return [
    { role: 'system', content: CUE_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

/** Deterministic key over exactly the fields Algorithm 1 takes as input, plus the model. */
function cacheKey(input: CueExtractionInput, model: string): string {
  const turns = (input.recentTurns ?? []).map((turn) => `${turn.role}\u0000${turn.text}`).join('\u0001');
  const raw = [model, input.query, input.summary ?? '', turns].join('\u0002');
  return createHash('sha256').update(raw).digest('hex');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

type CueModelCallResult = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly reason: Degradation['reason'] };

/** The one `generate` call, under the budget as a hang guard via `AbortController`. */
async function callCueModel(deps: CueExtractionDeps, input: CueExtractionInput): Promise<CueModelCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.budgetMs);
  try {
    const data = await deps.provider.generate({
      model: deps.model,
      messages: buildMessages(input),
      schema: CUE_OUTPUT_JSON_SCHEMA,
      temperature: CUE_MODEL_TEMPERATURE,
      // Cue extraction reads three sections and names what is in them. Reasoning buys nothing
      // here and costs the budget: with it on the pinned model busts 2000ms on every call.
      think: false,
      signal: controller.signal,
    });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, reason: isAbortError(error) ? 'timeout' : 'model_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PRD §6.1's ladder: "recall proceeds on query and summary embeddings plus BM25 over the raw
 * query text." Both of the caller's own text buckets carry through at their Algorithm 1
 * weights, because the summary is context the caller already extracted and dropping it costs
 * signal the degraded path has no other way to recover. The recent-turns bucket does not
 * carry: it is the procedural bucket Algorithm 1 weights lowest, and a verbatim turn is a
 * transcript line rather than a cue. Nothing here derives terms from the text.
 */
function degradedResult(
  input: CueExtractionInput,
  reason: Degradation['reason'],
): CueExtractionResult {
  const cues: Cue[] = [{ text: input.query.trim(), source: 'raw_query', weight: 3 }];
  const summary = input.summary?.trim();
  if (summary !== undefined && summary.length > 0) {
    cues.push({ text: summary, source: 'raw_summary', weight: 2 });
  }
  return {
    degraded: true,
    cues,
    degradation: { stage: 'cues', reason },
  };
}

/**
 * Buckets in weight order so a duplicate (case-insensitive) surfaces once, at its highest
 * weight. A bucket the caller never populated is dropped even if the model filled it in
 * anyway (a hallucinated summary cue with no summary in the input is not a summary cue).
 */
function toCues(
  output: z.infer<typeof CueModelOutputSchema>,
  presence: { readonly summary: boolean; readonly recentTurns: boolean },
): Cue[] {
  const buckets: readonly [readonly string[], CueSource, CueWeight][] = [
    [output.query_cues, 'query', 3],
    [presence.summary ? output.summary_cues : [], 'summary', 2],
    [presence.recentTurns ? output.recent_turn_cues : [], 'recent_turns', 1],
  ];

  const seen = new Set<string>();
  const cues: Cue[] = [];
  for (const [values, source, weight] of buckets) {
    for (const raw of values) {
      const text = raw.trim();
      if (text.length === 0) {
        continue;
      }
      const key = text.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      cues.push({ text, source, weight });
    }
  }
  return cues;
}

/**
 * PRD §6.1 / whitepaper Algorithm 1. Checks the cache, makes the one budgeted `generate`
 * call, validates the result, and maps it to weighted cues — or degrades to a single
 * raw-query cue on any failure along the way.
 */
export async function extractCues(deps: CueExtractionDeps, input: CueExtractionInput): Promise<CueExtractionResult> {
  const key = cacheKey(input, deps.model);
  const cached = deps.cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const call = await callCueModel(deps, input);
  if (!call.ok) {
    deps.logger.warn({ model: deps.model, reason: call.reason }, 'cue extraction degraded');
    return degradedResult(input, call.reason);
  }

  const parsed = CueModelOutputSchema.safeParse(call.data);
  if (!parsed.success) {
    deps.logger.warn({ model: deps.model, issues: parsed.error.issues }, 'cue extraction degraded');
    return degradedResult(input, 'invalid_output');
  }

  const result: CueExtractionResult = {
    degraded: false,
    cues: toCues(parsed.data, { summary: hasSummary(input), recentTurns: hasRecentTurns(input) }),
  };
  deps.cache.set(key, result);
  return result;
}
