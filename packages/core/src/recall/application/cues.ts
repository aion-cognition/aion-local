import type { Cue, CueSource, CueWeight, Degradation, RecallTurn } from '@aion/protocol';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { isAbortError } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { isGenerationUnavailable } from '../../infrastructure/providers/errors.js';
import type {
  ChatMessage,
  JsonSchema,
  Provider,
  StructuredRequest,
} from '../../infrastructure/providers/types.js';
import { CUES_PROMPT as CUE_SYSTEM_PROMPT } from '../../prompts/cue-extraction.js';

/**
 * One model call produces the cues: exactly one `generate` per invocation, which is all the
 * recall hot path allows. A failure, a busted budget, a response that fails validation, or a
 * substrate with no key at all degrades to the caller's own query and summary text verbatim,
 * never to keyword extraction over it.
 */

export type CueExtractionInput = {
  readonly query: string;
  readonly summary?: string;
  readonly recentTurns?: readonly RecallTurn[];
};

export type CueExtractionDeps = {
  readonly provider: Provider;
  /** `config.anthropic.model`. */
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
  readonly #entries = new Map<string, { result: CueExtractionResult; expiresAt: number }>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { maxEntries?: number; ttlMinutes?: number; now?: () => number } = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.#ttlMs = (options.ttlMinutes ?? DEFAULTS.recall.cueCacheTtlMinutes) * 60_000;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): CueExtractionResult | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(key: string, value: CueExtractionResult): void {
    if (this.#ttlMs <= 0 || this.#maxEntries <= 0 || value.degraded) {
      return;
    }
    if (!this.#entries.has(key) && this.#entries.size >= this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.#entries.delete(oldestKey);
      }
    }
    this.#entries.set(key, { result: value, expiresAt: this.#now() + this.#ttlMs });
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
    query_intent: { type: 'string', enum: ['decision', 'other'] },
  },
  required: ['query_cues', 'summary_cues', 'recent_turn_cues', 'query_intent'],
};

/**
 * `query_intent` is optional here and required in the JSON schema above. A provider that
 * constrains generation to the schema always fills it; one that does not should cost recall a
 * ranking hint, never the whole extraction. Degrading to the raw query because one enum was
 * missing would be a worse answer than ignoring the enum.
 */
const CueModelOutputSchema = z.object({
  query_cues: z.array(z.string()),
  summary_cues: z.array(z.string()),
  recent_turn_cues: z.array(z.string()),
  query_intent: z.enum(['decision', 'other']).optional(),
});

function hasSummary(
  input: CueExtractionInput,
): input is CueExtractionInput & { readonly summary: string } {
  return input.summary !== undefined && input.summary.trim().length > 0;
}

function hasRecentTurns(
  input: CueExtractionInput,
): input is CueExtractionInput & { readonly recentTurns: readonly RecallTurn[] } {
  return input.recentTurns !== undefined && input.recentTurns.length > 0;
}

function buildMessages(input: CueExtractionInput): ChatMessage[] {
  const sections = [`Query:\n${input.query.trim()}`];

  sections.push(
    hasSummary(input)
      ? `Conversation summary:\n${input.summary.trim()}`
      : 'Conversation summary:\n(none provided)',
  );

  sections.push(
    hasRecentTurns(input)
      ? `Recent turns:\n${input.recentTurns.map((turn) => `${turn.role}: ${turn.text}`).join('\n')}`
      : 'Recent turns:\n(none provided)',
  );

  return [
    { role: 'system', content: CUE_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

/** JSON preserves field boundaries even when user text contains control characters. */
function cacheKey(request: StructuredRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

type CueModelCallResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly reason: Degradation['reason'];
      /** Carried so the log can tell an outage from an auth rejection from a bad request. */
      readonly error: unknown;
    };

/** The one `generate` call, under the budget as a hang guard via `AbortController`. */
async function callCueModel(
  deps: CueExtractionDeps,
  request: StructuredRequest,
): Promise<CueModelCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.budgetMs);
  try {
    const data = await deps.provider.generate({
      ...request,
      signal: controller.signal,
    });
    return { ok: true, data };
  } catch (error) {
    if (isGenerationUnavailable(error)) {
      return { ok: false, reason: 'unavailable', error };
    }
    return { ok: false, reason: isAbortError(error) ? 'timeout' : 'model_error', error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A summary cue would weigh 2x. It is damped to 1x here, which applies the measurement by
 * weight rather than by wording: nothing rewrites or drops the caller's summary, so its cues
 * still seed and still corroborate, they just stop outranking the question.
 *
 * Measured, on one query against one substrate under four summaries: no context put the
 * answer at rank 7 of 21, "checking a specific measured number" at 9 of 23, "reviewing the
 * on-call handoff for Frankfurt" at 7 of 24, and "recalling my own recent work" MISSED, 4 of 4
 * across fresh sessions. No summary improved on no summary at all, and one destroyed the
 * answer, because summary cues compete with query cues for a seed budget that was exactly
 * full on all 1,480 logged recalls.
 *
 * Unconditional rather than model-judged. The pinned cue model was asked to judge whether a
 * summary named any specific thing, and could not hold that judgment and the intent judgment
 * in one prompt: across four prompt shapes it either inverted, collapsed to a constant, or
 * flipped run to run on the same input, and the shapes that kept it honest cost the intent
 * judgment instead. A weight that moves with the weather is worse than a lower weight.
 */
const SUMMARY_CUE_WEIGHT: CueWeight = 1;

/**
 * The degraded rung, and the whole of recall on a substrate with no key: recall proceeds on
 * query and summary embeddings plus BM25 over the raw query text. Both of the caller's own text buckets carry through, the summary at the same
 * damped weight the healthy path gives it, because the summary is context the caller already
 * extracted and dropping it costs signal the degraded path has no other way to recover. The
 * recent-turns bucket does not carry: it is the lowest-weighted bucket, and a verbatim turn
 * is a transcript line rather than a cue. Nothing here derives terms from the text.
 */
function degradedResult(
  input: CueExtractionInput,
  reason: Degradation['reason'],
): CueExtractionResult {
  return {
    degraded: true,
    cues: queryCues(input).cues,
    degradation: { stage: 'cues', reason },
  };
}

/**
 * The caller's own query, and its summary at the damped weight, with no model in between. The
 * degraded rung above serves these, and so do the `assess` and `raw` recall modes on purpose:
 * there the query is the primary retrieval input, and the model's judgment comes after retrieval
 * rather than before it.
 */
export function queryCues(input: CueExtractionInput): CueExtractionResult {
  const cues: Cue[] = [{ text: input.query.trim(), source: 'raw_query', weight: 3 }];
  const summary = input.summary?.trim();
  if (summary !== undefined && summary.length > 0) {
    cues.push({ text: summary, source: 'raw_summary', weight: SUMMARY_CUE_WEIGHT });
  }
  return { degraded: false, cues };
}

/**
 * Buckets in weight order so a duplicate (case-insensitive) surfaces once, at its highest
 * weight. A bucket the caller never populated is dropped even if the model filled it in
 * anyway (a hallucinated summary cue with no summary in the input is not a summary cue).
 *
 * The raw query leads every list, whatever the model returned. A cue set is the model's
 * reading of the question and the question itself is not negotiable: a lexically precise query
 * went missing entirely because the model split it into single words, and the same run measured
 * the raw-query path attributing 75 to 100% of its items to the right episode against 30% for
 * the model's own cues on a bare query.
 */
function toCues(
  input: CueExtractionInput,
  output: z.infer<typeof CueModelOutputSchema>,
  presence: { readonly summary: boolean; readonly recentTurns: boolean },
): Cue[] {
  const query = input.query.trim();
  const buckets: readonly [readonly string[], CueSource, CueWeight][] = [
    [query.length === 0 ? output.query_cues : [query, ...output.query_cues], 'query', 3],
    [presence.summary ? output.summary_cues : [], 'summary', SUMMARY_CUE_WEIGHT],
    [presence.recentTurns ? output.recent_turn_cues : [], 'recent_turns', 1],
  ];
  const intent = output.query_intent === 'decision' ? { intent: 'decision' as const } : {};

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
      cues.push({ text, source, weight, ...(source === 'query' ? intent : {}) });
    }
  }
  return cues;
}

/**
 * Checks the cache, makes the one budgeted `generate` call, validates the result, and maps it
 * to weighted cues, or degrades to a single raw-query cue on any failure along the way.
 */
export async function extractCues(
  deps: CueExtractionDeps,
  input: CueExtractionInput,
): Promise<CueExtractionResult> {
  const request: StructuredRequest = {
    surface: 'cues',
    model: deps.model,
    messages: buildMessages(input),
    schema: CUE_OUTPUT_JSON_SCHEMA,
    temperature: CUE_MODEL_TEMPERATURE,
    // Reasoning costs the cue budget without improving extraction from the supplied text.
    think: false,
  };
  const key = cacheKey(request);
  const cached = deps.cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const call = await callCueModel(deps, request);
  if (!call.ok) {
    // A substrate with no key is not an incident: it is the configuration, and it says so once
    // per call at debug rather than warning on every recall for the life of the install.
    if (call.reason === 'unavailable') {
      deps.logger.debug({ reason: call.reason }, 'cue extraction degraded to the raw query');
    } else {
      deps.logger.warn(
        { err: call.error, model: deps.model, reason: call.reason },
        'cue extraction degraded',
      );
    }
    return degradedResult(input, call.reason);
  }

  const parsed = CueModelOutputSchema.safeParse(call.data);
  if (!parsed.success) {
    deps.logger.warn({ model: deps.model, issues: parsed.error.issues }, 'cue extraction degraded');
    return degradedResult(input, 'invalid_output');
  }

  const result: CueExtractionResult = {
    degraded: false,
    cues: toCues(input, parsed.data, {
      summary: hasSummary(input),
      recentTurns: hasRecentTurns(input),
    }),
  };
  deps.cache.set(key, result);
  return result;
}

/**
 * The cues one recall searches with, by mode: the `cues` mode spends the recall role's model call
 * extracting them, and the other two search on the caller's own query and summary.
 */
export function recallCues(
  deps: Pick<CueExtractionDeps, 'provider' | 'logger'> & {
    readonly config: Config;
    readonly cueCache: CueCache;
  },
  input: CueExtractionInput,
): Promise<CueExtractionResult> {
  if (deps.config.recall.mode !== 'cues') {
    return Promise.resolve(queryCues(input));
  }
  return extractCues(
    {
      provider: deps.provider,
      model: deps.config.anthropic.model,
      budgetMs: deps.config.recall.cueBudgetMs,
      cache: deps.cueCache,
      logger: deps.logger,
    },
    input,
  );
}
