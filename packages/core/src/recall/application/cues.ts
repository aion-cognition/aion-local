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
    query_intent: { type: 'string', enum: ['decision', 'other'] },
  },
  required: ['query_cues', 'summary_cues', 'recent_turn_cues', 'query_intent'],
};

/**
 * `query_intent` is optional here and required in the JSON schema above. A provider that
 * constrains generation to the schema always fills it; one that does not should cost recall a
 * ranking hint, never the whole extraction — degrading to the raw query because one enum was
 * missing would be a worse answer than ignoring the enum.
 */
const CueModelOutputSchema = z.object({
  query_cues: z.array(z.string()),
  summary_cues: z.array(z.string()),
  recent_turn_cues: z.array(z.string()),
  query_intent: z.enum(['decision', 'other']).optional(),
});

/**
 * Two things this prompt has to hold, both measured against the pinned cue model.
 *
 * Invention: a query naming a topic the substrate has never held still produced confident,
 * on-topic-looking cues, so the ban on leaving the section is stated as a rule and repeated
 * as an instruction to return nothing rather than guess.
 *
 * Intent: whether a query asks what was chosen is a judgment, and the alternative to asking
 * for it is a keyword list, which the cognitive path does not get (PRD §2). Every clause after
 * "query_intent" is here because the model got that case wrong without it — a recommendation
 * read as a decision, a bug report read as a decision, and "why did we reject X" read as a
 * cause rather than as the choice it names. With them, the judgment was right on 11 of 12
 * probe queries and identical across three runs; without them, on 8 of 12. The survivor is
 * "what was that bug in the barrel exports", read as a decision; an over-fired boost lifts
 * Decision and Insight and admits nothing, so it costs ranking rather than honesty.
 */
const CUE_SYSTEM_PROMPT =
  'You extract short semantic search cues from an AI agent memory-recall query. ' +
  'A cue is a concept, entity, or theme worth searching a memory graph for, not ' +
  'necessarily an exact word from the input. The user message has three sections: ' +
  'the query, the conversation summary, and the recent turns. Extract cues separately ' +
  'for each section. Return an empty array for a section marked "(none provided)". ' +
  'Every cue must be about something the section itself names. Never introduce a topic, ' +
  'domain, or entity the section does not mention, and never guess what the user might ' +
  'have meant: if a section names nothing worth searching for, return an empty array for ' +
  'it. Fewer, well-grounded cues are better than more. Keep each cue to a few words and ' +
  'do not repeat one within its own section. ' +
  'Then judge the query. ' +
  'query_intent is "decision" only when the query asks which choice was already made or why ' +
  'it was made, as in "what did we decide about X", "did we decide to X", "why did we reject ' +
  'X". Everything else is "other", including a question asking for a fact, a number, a ' +
  'measurement, a bug, or a recommendation. "what is the best anchovy brand for puttanesca" ' +
  'is "other", because it asks for a recommendation rather than a choice already made. ' +
  '"what was that bug in the barrel exports" is "other", because it asks what happened ' +
  'rather than what was ' +
  'chosen. "why did we reject the Kafka proposal" is "decision", because a rejection is a ' +
  'choice that was already made, even though the question opens with "why". ' +
  'Judge the query alone: the summary never changes this answer.';

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
 * query text." Both of the caller's own text buckets carry through — the summary at the same
 * damped weight the healthy path gives it — because the summary is context the caller already
 * extracted and dropping it costs signal the degraded path has no other way to recover. The
 * recent-turns bucket does not carry: it is the procedural bucket Algorithm 1 weights lowest,
 * and a verbatim turn is a transcript line rather than a cue. Nothing here derives terms from
 * the text.
 */
function degradedResult(
  input: CueExtractionInput,
  reason: Degradation['reason'],
): CueExtractionResult {
  const cues: Cue[] = [{ text: input.query.trim(), source: 'raw_query', weight: 3 }];
  const summary = input.summary?.trim();
  if (summary !== undefined && summary.length > 0) {
    cues.push({ text: summary, source: 'raw_summary', weight: SUMMARY_CUE_WEIGHT });
  }
  return {
    degraded: true,
    cues,
    degradation: { stage: 'cues', reason },
  };
}

/**
 * Algorithm 1 weighs a summary cue 2x. It is damped to 1x here, which is the measured finding
 * applied by weight rather than by wording: nothing rewrites or drops the caller's summary,
 * so its cues still seed and still corroborate, they just stop outranking the question.
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
 * Buckets in weight order so a duplicate (case-insensitive) surfaces once, at its highest
 * weight. A bucket the caller never populated is dropped even if the model filled it in
 * anyway (a hallucinated summary cue with no summary in the input is not a summary cue).
 *
 * The raw query leads every list, whatever the model returned. A cue set is the model's
 * reading of the question and the question itself is not negotiable: the exercise measured a
 * lexically precise query missing entirely because the model split it into single words, and
 * the same run measured the raw-query path attributing 75 to 100% of its items to the right
 * episode against 30% for the model's own cues on a bare query.
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
    cues: toCues(input, parsed.data, {
      summary: hasSummary(input),
      recentTurns: hasRecentTurns(input),
    }),
  };
  deps.cache.set(key, result);
  return result;
}
