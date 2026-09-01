import {
  attachVectors,
  ENTITY_EXTRACTION_METHOD,
  EXTRACTION_CONFIDENCE,
  resolveEntities,
} from './entity-resolution.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { isAbortError } from '../../../infrastructure/errors.js';
import { linkEntityMentions } from '../../../infrastructure/graph/entity-queries.js';
import type { ChatMessage } from '../../../infrastructure/providers/types.js';
import {
  ENTITY_EXTRACTION_JSON_SCHEMA,
  ENTITY_TYPES,
  parseExtractedEntities,
  type ExtractedEntity,
} from '../../domain/entity-extraction.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

export { ENTITY_EXTRACTION_METHOD } from './entity-resolution.js';

/**
 * The model names the entities in an episode, each name resolves to exactly one node, and
 * the episode records that it mentioned them.
 *
 * The extraction is the only judgment call in the pipeline that a heuristic could fake, and
 * it does not get one. A failed or unusable answer is retried once with the first attempt in
 * the prompt, triggered by an unusable answer rather than by scoring the text the model was
 * given, and a second failure fails the stage: the episode stays queued behind an unmarked
 * ledger key instead of being enriched with regex-shaped entities the rest of the graph would
 * then treat as real.
 */

export const ENTITY_STAGE_NAME = 'entities';

/** Extraction is a reading of fixed text; sampling it would make one episode two graphs. */
const EXTRACTION_TEMPERATURE = 0;

/** The refinement prompt carries the rejected answer, capped so a runaway one cannot fill the context. */
const MAX_ECHOED_OUTPUT_LENGTH = 2000;

const SYSTEM_PROMPT =
  'You extract named entities from a record of one session between a user and an AI ' +
  'agent. The record holds a summary line, the conversation turns, any tools the agent ' +
  'ran with their input and output, and any observations. Return every distinct thing the ' +
  'record actually names: people, organizations, projects, tools, topics, locations, ' +
  'and events. Give each one the name the record uses, one type from the allowed list, ' +
  'and a short clause describing it as this record uses it. Name a thing once, under its ' +
  'fullest name, and list every other name the record used for it in its aliases: an ' +
  'abbreviation, an initialism, a handle, a shortened form. Set is_speaker true on the ' +
  'person who is the user speaking in this record, and on no one else. Do not return a ' +
  'thing the record does not name, a pronoun, or a generic noun that identifies nothing in ' +
  `particular. Allowed types: ${ENTITY_TYPES.join(', ')}.`;

const REFINEMENT_PROMPT =
  'A previous extraction over the same record was rejected. Read the record again and ' +
  'return a correct extraction. Keep the entities the previous attempt got right, drop ' +
  'anything the record does not name, and use only the allowed types.';

export type EntityStageOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxEntities: number;
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
      model: DEFAULTS.models.reflect,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      maxEntities: DEFAULTS.reflection.maxEntities,
      ...options,
    };
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const body = ctx.episode.text.trim();
    if (body.length === 0) {
      return { status: 'skipped', summary: 'episode carries no text to extract from' };
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
    const mentions = await linkEntityMentions(ctx.driver, {
      episodeId: ctx.episodeId,
      entityIds: resolved.map((entity) => entity.id),
      now: ctx.now,
      confidence: EXTRACTION_CONFIDENCE,
      provenance: [ENTITY_EXTRACTION_METHOD],
    });

    const created = resolved.filter((entity) => entity.created).length;
    const structural = resolved.filter((entity) => entity.structural).length;
    return {
      status: 'ok',
      summary:
        `${resolved.length} entities (${created} new, ${structural} structural), ` +
        `${mentions} mentions${deferred ? ', vectors deferred' : ''}`,
      counts: { entities: created, mentions },
    };
  }

  /** One `generate` call, then at most one refinement of it. Each carries its own abort signal. */
  async #extract(ctx: StageContext, body: string): Promise<ExtractionResult> {
    const first = await this.#call(ctx, firstAttemptMessages(body));
    const attempted = first.ok
      ? parseExtractedEntities(first.data, this.#options.maxEntities)
      : undefined;
    if (attempted !== undefined && attempted.length > 0) {
      return { ok: true, entities: attempted };
    }

    const rejected = first.ok ? echo(first.data) : '(the call failed)';
    let reason: string;
    if (first.ok) {
      reason =
        attempted === undefined ? 'it did not match the required shape' : 'it named no entities';
    } else {
      ({ reason } = first);
    }
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
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#options.timeoutMs);
    try {
      const data = await ctx.provider.generate({
        model: this.#options.model,
        messages,
        schema: ENTITY_EXTRACTION_JSON_SCHEMA,
        temperature: EXTRACTION_TEMPERATURE,
        // Reasoning buys nothing on a naming task and costs the guard: the pinned model
        // runs tens of seconds with it on, and sometimes does not return.
        think: false,
        signal: controller.signal,
      });
      return { ok: true, data };
    } catch (err) {
      return { ok: false, reason: describe(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
