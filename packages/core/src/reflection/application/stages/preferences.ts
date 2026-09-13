import { recordDerivedEvidence } from './derived-evidence.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { describeError, isAbortError } from '../../../infrastructure/errors.js';
import { readMemberId } from '../../../infrastructure/graph/backbone.js';
import { normalizeCognitiveText } from '../../../infrastructure/graph/cognitive-text.js';
import { DERIVES_FROM_TYPE } from '../../../infrastructure/graph/narrative-queries.js';
import {
  derivePreferenceId,
  findStandingPreferences,
  writePreference,
} from '../../../infrastructure/graph/preference-queries.js';
import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Vector } from '../../../infrastructure/providers/types.js';
import { getLastPack } from '../../../infrastructure/sqlite/last-pack.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { PREFERENCES_PROMPT as SYSTEM_PROMPT } from '../../../prompts/preferences.js';
import { generationSkipReason } from '../../domain/capture-class.js';
import {
  parsePreferenceAnswer,
  plannedPreferences,
  PREFERENCE_SCOPES,
  preferenceSignalKey,
  signalTag,
  standingTag,
  type PlannedPreference,
  type PreferenceSignal,
  type StandingPreference,
} from '../../domain/preferences.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';
import { derivedNode, owesBirthEstablishment, type DerivedNode } from '../derived-node-evidence.js';

/**
 * One structured-output call per episode reading how the member likes to work off how they
 * worked: what they correct, what they ask for again, what they keep doing the same way.
 *
 * Bounded around new signals. The pass reads this episode's turns and nothing else of the
 * history, so what bounds the model's input is the interaction rather than the three slots
 * serving has for the result. `reflection/domain/preferences.ts` owns the key the pass is
 * recorded under, which carries every standing preference at the revision it was read at, so a
 * later signal that revises one is asked about rather than skipped.
 *
 * Three things keep an inference from turning into a quotation. The node is written `inferred`
 * and serves under its own standing, so nothing renders it as a sentence the member said. The
 * recorded roles of the lines it was read off travel onto it verbatim and nothing branches on
 * them, because a role is a transport label and agent-to-agent traffic arrives under `user`.
 * And no path here writes a confirmation: a preference gains observations from distinct lines
 * it has not been read off before, and from nothing else, so the substrate repeating a
 * preference back at itself cannot become evidence for it.
 */

export const PREFERENCE_STAGE_NAME = 'preferences';

export type PreferenceStageOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  /** Preferences one pass may write. Past it the pass declines rather than truncating quietly. */
  readonly maxPreferences: number;
  /** Lines of the episode one pass reads. It bounds the model's input, not the output slots. */
  readonly maxSignals: number;
  /** Standing preferences one pass is shown, so a revision has something to name. */
  readonly maxStanding: number;
  readonly minExtractionChars: number;
};

const PREFERENCE_TEMPERATURE = 0;

export const PREFERENCE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    preferences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          grounds: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string', enum: [...PREFERENCE_SCOPES] },
          context: { type: 'string' },
          revises: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['text', 'grounds', 'scope'],
      },
    },
  },
  required: ['preferences'],
};

function renderSignal(signal: PreferenceSignal, index: number): string {
  return `${signalTag(index)} (recorded role ${signal.role}): ${signal.text}`;
}

function renderStanding(prior: StandingPreference, index: number): string {
  const held = prior.context === undefined ? '' : `, when ${prior.context}`;
  return `${standingTag(index)} (${prior.scope}${held}): ${prior.text}`;
}

function buildMessages(
  signals: readonly PreferenceSignal[],
  standing: readonly StandingPreference[],
): ChatMessage[] {
  const lines = signals.map((signal, index) => renderSignal(signal, index)).join('\n');
  const held =
    standing.length === 0
      ? ''
      : `\n\nPreferences already held:\n${standing
          .map((prior, index) => renderStanding(prior, index))
          .join('\n')}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Lines:\n${lines}${held}` },
  ];
}

export class PreferenceInferenceStage implements ReflectionStage {
  readonly name = PREFERENCE_STAGE_NAME;
  readonly #options: PreferenceStageOptions;

  constructor(options: Partial<PreferenceStageOptions> = {}) {
    this.#options = {
      model: DEFAULTS.anthropic.model,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      maxPreferences: DEFAULTS.recall.maxPreferences,
      maxSignals: DEFAULTS.reflection.maxPreferenceSignals,
      maxStanding: DEFAULTS.reflection.maxStandingPreferences,
      minExtractionChars: DEFAULTS.reflection.minExtractionChars,
      ...options,
    };
  }

  /**
   * The options this instance actually runs on. `maxPreferences` is the serving cap, threaded
   * here rather than defaulted, so a deployment that widened the bucket does not find the
   * producer still writing three.
   */
  describe(): PreferenceStageOptions {
    return this.#options;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const declined = generationSkipReason(ctx.episode, this.#options.minExtractionChars);
    if (declined !== undefined) {
      return {
        status: 'skipped',
        summary: declined,
        settled: {
          disposition: 'not_applicable',
          reason: 'below_minimum_input',
          proof: { minExtractionChars: this.#options.minExtractionChars },
        },
      };
    }

    const standing = await this.#standing(ctx);
    const signals = this.#signals(ctx, standing);
    // Nothing to read, so there is nothing to read it off: every preference the model could
    // answer with would cite a line this pass never showed, and the domain refuses those. How
    // many occurrences a line describes is the model's to judge, and one line can describe years
    // of them, so the count itself decides nothing here.
    if (signals.length === 0) {
      return {
        status: 'skipped',
        summary: 'the episode carries no readable line to read a preference off',
        settled: {
          disposition: 'not_applicable',
          reason: 'proved_empty_input',
          proof: { signals: 0 },
        },
      };
    }

    const key = preferenceSignalKey(ctx.pipelineVersion, ctx.episodeId, signals, standing);
    if (isLedgerApplied(ctx.db, key)) {
      return {
        status: 'skipped',
        summary: 'these lines were already read under these preferences',
        settled: {
          disposition: 'complete',
          reason: 'effects_already_recorded',
          proof: { signals: signals.length, standing: standing.length },
        },
      };
    }

    const deadline = deadlineFor(this.#options.timeoutMs, ctx.signal);
    let raw: unknown;
    try {
      raw = await ctx.provider.generate({
        surface: 'preferences',
        model: this.#options.model,
        messages: buildMessages(signals, standing),
        schema: PREFERENCE_JSON_SCHEMA,
        temperature: PREFERENCE_TEMPERATURE,
        think: false,
        signal: deadline.signal,
      });
    } catch (error) {
      return {
        status: 'failed',
        summary: `preference inference call ${isAbortError(error) ? 'timed out' : 'failed'}: ${describeError(error)}`,
      };
    } finally {
      deadline.clear();
    }

    const answer = parsePreferenceAnswer(raw);
    if (answer.status === 'unusable') {
      return { status: 'failed', summary: 'preference inference returned no list of preferences' };
    }
    const plan = plannedPreferences(answer.preferences, {
      signals,
      standing,
      max: this.#options.maxPreferences,
    });
    if (plan.preferences.length === 0) {
      markLedgerApplied(ctx.db, key, { preferences: 0, refused: plan.refused.length });
      return {
        status: 'ok',
        summary: `no preference across ${String(signals.length)} line(s)${
          plan.refused.length === 0 ? '' : `, ${String(plan.refused.length)} refused`
        }`,
        counts: { preferences: 0 },
      };
    }

    return await this.#write(ctx, key, plan.preferences, plan.refused);
  }

  /**
   * The lines this pass reads, and which of them the substrate has already used.
   *
   * A line already standing behind a preference is marked as an echo: reading the same line
   * again is the substrate agreeing with itself, and the domain refuses a preference grounded
   * only in those. The turns are taken in the order they were spoken and bounded from the end,
   * so a long episode contributes its most recent working rather than its opening.
   */
  #signals(
    ctx: StageContext,
    standing: readonly StandingPreference[],
  ): readonly PreferenceSignal[] {
    const used = new Set(standing.flatMap((prior) => prior.groundIds));
    return ctx.episode.turns
      .filter((turn) => turn.text.trim().length > 0)
      .slice(-this.#options.maxSignals)
      .map((turn) => ({
        id: turn.id,
        role: turn.role,
        text: turn.text.trim(),
        echo: used.has(turn.id),
      }));
  }

  /** What the substrate already holds, or none of it: a read that failed costs the pass revisions, not the pass. */
  async #standing(ctx: StageContext): Promise<readonly StandingPreference[]> {
    try {
      const rows = await findStandingPreferences(ctx.driver, this.#options.maxStanding);
      return rows.map((row) => ({
        id: row.id,
        text: row.text,
        revision: row.revision,
        scope: row.scope === 'contextual' ? 'contextual' : 'standing',
        ...(row.context === undefined ? {} : { context: row.context }),
        groundIds: row.groundIds,
      }));
    } catch (error) {
      ctx.logger.warn(
        { err: error, episodeId: ctx.episodeId },
        'preference inference: could not read the held preferences, reading this episode alone',
      );
      return [];
    }
  }

  /**
   * The preferences, their grounds and the record of what stands behind them.
   *
   * A preference the substrate already served into this session is not written again from it.
   * The pack the agent was handed carried that preference, and anything the agent then said
   * about it is the substrate's own output coming back: counting it would let one inference
   * accumulate observations by being read aloud.
   */
  async #write(
    ctx: StageContext,
    key: string,
    preferences: readonly PlannedPreference[],
    refused: readonly string[],
  ): Promise<StageOutcome> {
    const memberId = await readMemberId(ctx.driver);
    if (memberId === undefined) {
      return { status: 'failed', summary: 'preference inference found no member to hold them' };
    }
    const served = this.#servedThisSession(ctx);

    let vectors: readonly Vector[] = [];
    try {
      vectors = await ctx.provider.embed(preferences.map((entry) => entry.text));
    } catch (error) {
      ctx.logger.warn(
        { err: error, episodeId: ctx.episodeId },
        'preference inference: embedding failed, writing preferences without content vectors',
      );
    }

    const derived: DerivedNode[] = [];
    const echoed: string[] = [];
    let written = 0;
    let revised = 0;
    let writeError: unknown;
    for (const [index, preference] of preferences.entries()) {
      const textNorm = normalizeCognitiveText(preference.text);
      if (served.has(derivePreferenceId(memberId, textNorm, preference.context))) {
        echoed.push(preference.text);
        continue;
      }
      try {
        const result = await writePreference(ctx.driver, {
          memberId,
          text: preference.text,
          textNorm,
          groundIds: preference.groundIds,
          roles: preference.roles,
          scope: preference.scope,
          ...(preference.context === undefined ? {} : { context: preference.context }),
          confidence: preference.confidence,
          ...(vectors[index] === undefined ? {} : { contentVector: vectors[index] }),
          ...(preference.outcome.kind === 'replaces'
            ? { replacesId: preference.outcome.priorId }
            : {}),
          occurredAt: ctx.occurredAt,
          now: ctx.now,
        });
        written += 1;
        if (result.replacedId !== undefined) {
          revised += 1;
        }
        const minted = result.created || owesBirthEstablishment(ctx.db, result.id);
        derived.push(
          derivedNode({
            nodeId: result.id,
            role: 'extraction',
            relationType: DERIVES_FROM_TYPE,
            sourceId: ctx.episodeId,
            minted,
          }),
        );
      } catch (error) {
        writeError = error;
        break;
      }
    }

    const recorded = await recordDerivedEvidence(ctx, 'preference inference', derived);
    if (recorded !== undefined) {
      return recorded;
    }
    if (writeError !== undefined) {
      return {
        status: 'failed',
        summary: `preference inference wrote ${String(written)} of ${String(preferences.length)} before a graph write failed: ${describeError(writeError)}`,
        ...(written > 0 ? { counts: { preferences: written } } : {}),
      };
    }

    markLedgerApplied(ctx.db, key, { preferences: written, revised, echoed: echoed.length });
    const notes = [
      revised === 0 ? '' : `${String(revised)} revising a held one`,
      echoed.length === 0 ? '' : `${String(echoed.length)} already served this session`,
      refused.length === 0 ? '' : `${String(refused.length)} refused`,
    ].filter((part) => part.length > 0);
    return {
      status: 'ok',
      summary: `read ${String(written)} preference(s)${notes.length === 0 ? '' : `, ${notes.join(', ')}`}`,
      counts: { preferences: written },
    };
  }

  /** The ids this session's last pack carried, which is what the agent has already been shown. */
  #servedThisSession(ctx: StageContext): ReadonlySet<string> {
    const last = getLastPack(ctx.db, ctx.episode.sessionId);
    if (last === undefined) {
      return new Set();
    }
    const pack = last.pack as { preferences?: readonly { id?: unknown }[] } | null;
    const served = pack?.preferences ?? [];
    return new Set(
      served.map((item) => item.id).filter((id): id is string => typeof id === 'string'),
    );
  }
}
