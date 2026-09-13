import { recordDerivedEvidence } from './derived-evidence.js';
import {
  attachVectors,
  ENTITY_EXTRACTION_METHOD,
  EXTRACTION_CONFIDENCE,
  resolveEntities,
} from './entity-resolution.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { isAbortError } from '../../../infrastructure/errors.js';
import { linkEntityMentions } from '../../../infrastructure/graph/entity-queries.js';
import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage } from '../../../infrastructure/providers/types.js';
import {
  EXTRACTION_PROMPT as SYSTEM_PROMPT,
  REFINEMENT_PROMPT,
} from '../../../prompts/entity-extraction.js';
import { generationSkipReason } from '../../domain/capture-class.js';
import {
  ENTITY_EXTRACTION_JSON_SCHEMA,
  parseExtractedEntities,
  type ExtractedEntity,
} from '../../domain/entity-extraction.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';
import { derivedNode } from '../derived-node-evidence.js';

export { ENTITY_EXTRACTION_METHOD } from './entity-resolution.js';

/**
 * The model names the entities in an episode, each name resolves to exactly one node, and the
 * episode records both relationships it wrote: that it mentioned them, and that they took part
 * in it.
 *
 * The extraction is the only judgment call in the pipeline that a heuristic could fake, and
 * it does not get one. A failed or unusable answer is retried once with the first attempt in
 * the prompt, triggered by an unusable answer rather than by scoring the text the model was
 * given, and a second failure fails the stage: the episode stays queued behind an unmarked
 * ledger key instead of being enriched with regex-shaped entities the rest of the graph would
 * then treat as real. An answer that names nothing is not an unusable one.
 */

export const ENTITY_STAGE_NAME = 'entities';

/** Extraction is a reading of fixed text; sampling it would make one episode two graphs. */
const EXTRACTION_TEMPERATURE = 0;

/** The refinement prompt carries the rejected answer, capped so a runaway one cannot fill the context. */
const MAX_ECHOED_OUTPUT_LENGTH = 2000;

export type EntityStageOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxEntities: number;
  /** The byte floor `capture-class.ts` applies to the one capture class it bounds. */
  readonly minExtractionChars: number;
};

type ExtractionResult =
  | { readonly ok: true; readonly entities: readonly ExtractedEntity[] }
  | { readonly ok: false; readonly summary: string };

function describe(error: unknown): string {
  if (isAbortError(error)) {
    return 'timed out';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function echo(value: unknown): string {
  let rendered: string;
  try {
    // lib.es5 types JSON.stringify as always returning `string`, and TS's control-flow
    // analysis trusts that over a local widening annotation or cast. At runtime it returns
    // `undefined` for a value JSON cannot represent (bare `undefined`, a function, a
    // symbol), which is exactly the case this fallback exists to cover.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see comment above
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  return rendered.slice(0, MAX_ECHOED_OUTPUT_LENGTH);
}

function firstAttemptMessages(body: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Record:\n${body}` },
  ];
}

/** The rejected answer goes back into the prompt so the retry corrects it rather than repeating it. */
function refinementMessages(body: string, rejected: string, reason: string): ChatMessage[] {
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${REFINEMENT_PROMPT}` },
    {
      role: 'user',
      content: [`Record:\n${body}`, `Previous attempt (${reason}):\n${rejected}`].join('\n\n'),
    },
  ];
}

export class EntityExtractionStage implements ReflectionStage {
  readonly name = ENTITY_STAGE_NAME;
  readonly #options: EntityStageOptions;

  constructor(options: Partial<EntityStageOptions> = {}) {
    this.#options = {
      model: DEFAULTS.anthropic.model,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      maxEntities: DEFAULTS.reflection.maxEntities,
      minExtractionChars: DEFAULTS.reflection.minExtractionChars,
      ...options,
    };
  }

  /**
   * The options this instance actually runs on. Every one reaches the stage only through
   * construction, so without a reader a build that dropped the wiring extracts under the
   * constructor defaults while the deployment's own model and cap sit unread.
   */
  describe(): EntityStageOptions {
    return this.#options;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const body = ctx.episode.text.trim();
    if (body.length === 0) {
      return {
        status: 'skipped',
        summary: 'episode carries no text to extract from',
        settled: {
          disposition: 'not_applicable',
          reason: 'below_minimum_input',
          proof: { textChars: 0 },
        },
      };
    }
    const declined = generationSkipReason(ctx.episode, this.#options.minExtractionChars);
    if (declined !== undefined) {
      return {
        status: 'skipped',
        summary: declined,
        settled: {
          disposition: 'not_applicable',
          reason: 'below_minimum_input',
          proof: { minExtractionChars: this.#options.minExtractionChars, textChars: body.length },
        },
      };
    }

    const extraction = await this.#extract(ctx, body);
    if (!extraction.ok) {
      return { status: 'failed', summary: extraction.summary };
    }
    if (extraction.entities.length === 0) {
      return {
        status: 'ok',
        summary: 'the episode names no entities',
        counts: { entities: 0, mentions: 0 },
      };
    }

    const resolved = await resolveEntities(ctx, extraction.entities);
    const deferred = await attachVectors(ctx, resolved);
    const links = await linkEntityMentions(ctx.driver, {
      episodeId: ctx.episodeId,
      entityIds: resolved.map((entity) => entity.id),
      now: ctx.now,
      confidence: EXTRACTION_CONFIDENCE,
      provenance: [ENTITY_EXTRACTION_METHOD],
    });

    // Both relationships the write above made, each under the role it carries and with the
    // identity the graph gave it. The mention is the episode standing behind the entity, the
    // participation is the entity standing in the experience, and a record of one is no record of
    // the other: an edge whose fact nothing durable holds is one the eviction cut has to refuse.
    // A minted entity is counted here because this write drew its id; an entity an earlier run
    // created keeps that run's census and this one only moves the counters.
    const minted = new Set(resolved.filter((entity) => entity.minted).map((entity) => entity.id));
    const recorded = await recordDerivedEvidence(
      ctx,
      'entity extraction',
      links.flatMap((link) => [
        derivedNode({
          nodeId: link.entityId,
          role: 'mention',
          relationType: link.mention.type,
          relationId: link.mention.id,
          sourceId: ctx.episodeId,
          minted: minted.has(link.entityId),
        }),
        derivedNode({
          nodeId: link.entityId,
          role: 'participation',
          relationType: link.participation.type,
          relationId: link.participation.id,
          sourceId: ctx.episodeId,
          minted: minted.has(link.entityId),
        }),
      ]),
    );
    if (recorded !== undefined) {
      return recorded;
    }

    const created = resolved.filter((entity) => entity.created).length;
    const structural = resolved.filter((entity) => entity.structural).length;
    const mentions = links.length;
    return {
      status: 'ok',
      summary:
        `${resolved.length} entities (${created} new, ${structural} structural), ` +
        `${mentions} mentions${deferred ? ', vectors deferred' : ''}`,
      counts: { entities: created, mentions },
    };
  }

  /**
   * One `generate` call, then at most one refinement of it. Each carries its own abort signal.
   *
   * An extraction that named nothing is an answer and is taken as one. Re-reading the record
   * asks the model to find an entity in a record that may hold none, and a model asked twice
   * answers with the phrase it declined the first time.
   */
  async #extract(ctx: StageContext, body: string): Promise<ExtractionResult> {
    const first = await this.#call(ctx, firstAttemptMessages(body));
    const attempted = first.ok
      ? parseExtractedEntities(first.data, this.#options.maxEntities)
      : undefined;
    if (attempted !== undefined) {
      return { ok: true, entities: attempted };
    }

    const rejected = first.ok ? echo(first.data) : '(the call failed)';
    const reason = first.ok ? 'it did not match the required shape' : first.reason;
    ctx.logger.info(
      { episodeId: ctx.episodeId, model: this.#options.model, reason },
      'entity extraction refining',
    );

    const second = await this.#call(ctx, refinementMessages(body, rejected, reason));
    if (!second.ok) {
      return { ok: false, summary: `entity extraction failed after refinement: ${second.reason}` };
    }
    const entities = parseExtractedEntities(second.data, this.#options.maxEntities);
    if (entities === undefined) {
      return { ok: false, summary: 'entity extraction returned an unusable shape twice' };
    }
    return { ok: true, entities };
  }

  async #call(
    ctx: StageContext,
    messages: readonly ChatMessage[],
  ): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
    const deadline = deadlineFor(this.#options.timeoutMs, ctx.signal);
    try {
      const data = await ctx.provider.generate({
        surface: 'entities',
        model: this.#options.model,
        messages,
        schema: ENTITY_EXTRACTION_JSON_SCHEMA,
        temperature: EXTRACTION_TEMPERATURE,
        // Reasoning buys nothing on a naming task and costs the guard: the pinned model
        // runs tens of seconds with it on, and sometimes does not return.
        think: false,
        signal: deadline.signal,
      });
      return { ok: true, data };
    } catch (err) {
      return { ok: false, reason: describe(err) };
    } finally {
      deadline.clear();
    }
  }
}
