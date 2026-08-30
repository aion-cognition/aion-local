import {
  findStructuralEntitiesByName,
  linkEntityMentions,
  mergeEntities,
  writeEntityVectors,
  type EntityMergeInput,
  type EntityVectorEntry,
} from '../../../infrastructure/graph/entity-queries.js';
import type { ChatMessage, Vector } from '../../../infrastructure/providers/types.js';
import {
  ENTITY_EXTRACTION_JSON_SCHEMA,
  ENTITY_TYPES,
  entityContentText,
  parseExtractedEntities,
  type ExtractedEntity,
} from '../../domain/entity-extraction.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

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

/** `config.models.reflect`; callers thread the configured value in. */
export const DEFAULT_ENTITY_MODEL = 'qwen3:8b';

/**
 * A hang guard, not a target. Reflection is asynchronous, but `qwen3:8b` occasionally does
 * not return at all, and a stage without its own signal would hold the worker forever, since
 * the orchestrator imposes no timeout.
 */
export const DEFAULT_ENTITY_TIMEOUT_MS = 60_000;

/** Enough for a long working session; a model that returns more is padding, not reading. */
export const DEFAULT_MAX_ENTITIES = 32;

/** Provenance: which pipeline path put the node in the graph. */
export const ENTITY_EXTRACTION_METHOD = 'reflection_entities';

/**
 * Structured output constrains the shape, never the reading. The confidence rides on both
 * the node and its MENTIONS edge so a later stage weighing an extracted claim against a
 * stated one can tell them apart.
 */
const EXTRACTION_CONFIDENCE = 0.8;

/** Extraction is a reading of fixed text; sampling it would make one episode two graphs. */
const EXTRACTION_TEMPERATURE = 0;

/** The refinement prompt carries the rejected answer, capped so a runaway one cannot fill the context. */
const MAX_ECHOED_OUTPUT_LENGTH = 2000;

const SYSTEM_PROMPT =
  'You extract named entities from a record of one session between a user and an AI ' +
  'agent. The record holds a summary line, the conversation turns, any tools the agent ' +
  'ran with their input and output, and any observations. Return every distinct thing the ' +
  'record actually names: people, organizations, projects, tools, concepts, locations, ' +
  'and events. Give each one the name the record uses, one type from the allowed list, ' +
  'and a short clause describing it as this record uses it. Name a thing once, under its ' +
  'fullest name. Do not return a thing the record does not name, a pronoun, or a generic ' +
  `noun that identifies nothing in particular. Allowed types: ${ENTITY_TYPES.join(', ')}.`;

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

/** One resolved identity: the extraction that named it and the node it landed on. */
type ResolvedEntity = {
  readonly extracted: ExtractedEntity;
  readonly id: string;
  readonly created: boolean;
  readonly structural: boolean;
  readonly needsNameVector: boolean;
  readonly needsContentVector: boolean;
};

function identityKey(nameNorm: string, type: string): string {
  return `${nameNorm} ${type}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

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

function mergeInput(entity: ExtractedEntity, ctx: StageContext): EntityMergeInput {
  return {
    name: entity.name,
    nameNorm: entity.nameNorm,
    type: entity.type,
    text: entityContentText(entity),
    sourceEpisodeId: ctx.episodeId,
    extractionMethod: ENTITY_EXTRACTION_METHOD,
    confidence: EXTRACTION_CONFIDENCE,
    ...(ctx.episode.occurredAt === undefined ? {} : { occurredAt: ctx.episode.occurredAt }),
  };
}

/**
 * Merge on collision: a name the backbone already answers to resolves to the structural
 * node. That node keeps its own type and identity properties (every session already hangs
 * off it) and gains only what any mentioned entity gains: a name embedding, the mention
 * edge, and the salience.
 */
async function resolveEntities(
  ctx: StageContext,
  entities: readonly ExtractedEntity[],
): Promise<readonly ResolvedEntity[]> {
  const structural = await findStructuralEntitiesByName(
    ctx.driver,
    entities.map((entity) => entity.nameNorm),
  );
  const byName = new Map(structural.map((match) => [match.nameNorm, match]));

  const organic = entities
    .filter((entity) => !byName.has(entity.nameNorm))
    .map((entity) => mergeInput(entity, ctx));
  const merged = await mergeEntities(ctx.driver, organic, ctx.now);
  const byIdentity = new Map(merged.map((row) => [identityKey(row.nameNorm, row.type), row]));

  const resolved: ResolvedEntity[] = [];
  for (const entity of entities) {
    const match = byName.get(entity.nameNorm);
    if (match !== undefined) {
      resolved.push({
        extracted: entity,
        id: match.id,
        created: false,
        structural: true,
        needsNameVector: !match.hasNameVector,
        // The backbone is connectivity, not content: it carries no `text` to embed.
        needsContentVector: false,
      });
      continue;
    }

    const row = byIdentity.get(identityKey(entity.nameNorm, entity.type));
    if (row === undefined) {
      continue;
    }
    resolved.push({
      extracted: entity,
      id: row.id,
      created: row.created,
      structural: false,
      needsNameVector: !row.hasNameVector,
      needsContentVector: !row.hasContentVector,
    });
  }

  return resolved;
}

/** Where in the one embed batch each of an entity's two vectors landed. */
type VectorSlot = {
  readonly id: string;
  readonly nameIndex?: number;
  readonly contentIndex?: number;
};

type VectorPlan = {
  readonly texts: readonly string[];
  readonly slots: readonly VectorSlot[];
};

/** One embed call for the whole extraction, over exactly the vectors that are missing. */
function planVectors(resolved: readonly ResolvedEntity[]): VectorPlan {
  const texts: string[] = [];
  const slots: VectorSlot[] = [];

  for (const entity of resolved) {
    if (!entity.needsNameVector && !entity.needsContentVector) {
      continue;
    }
    slots.push({
      id: entity.id,
      ...(entity.needsNameVector ? { nameIndex: texts.push(entity.extracted.name) - 1 } : {}),
      ...(entity.needsContentVector
        ? { contentIndex: texts.push(entityContentText(entity.extracted)) - 1 }
        : {}),
    });
  }

  return { texts, slots };
}

/**
 * A provider that returns a short list leaves the tail without vectors rather than
 * mis-pairing it: the node keeps `text` and no `content_vec`, which is the pending-vector
 * marker the worker's drain already resolves.
 */
function pairVectors(plan: VectorPlan, vectors: readonly Vector[]): EntityVectorEntry[] {
  const entries: EntityVectorEntry[] = [];
  for (const slot of plan.slots) {
    const nameVector = slot.nameIndex === undefined ? undefined : vectors[slot.nameIndex];
    const contentVector = slot.contentIndex === undefined ? undefined : vectors[slot.contentIndex];
    if (nameVector === undefined && contentVector === undefined) {
      continue;
    }
    entries.push({
      id: slot.id,
      ...(nameVector === undefined ? {} : { nameVector }),
      ...(contentVector === undefined ? {} : { contentVector }),
    });
  }
  return entries;
}

/** True when the vectors are deferred. The entities are already durable, so this never fails the stage. */
async function attachVectors(
  ctx: StageContext,
  resolved: readonly ResolvedEntity[],
): Promise<boolean> {
  const plan = planVectors(resolved);
  if (plan.texts.length === 0) {
    return false;
  }

  try {
    const vectors = await ctx.provider.embed(plan.texts);
    await writeEntityVectors(ctx.driver, pairVectors(plan, vectors));
    return false;
  } catch (err) {
    ctx.logger.warn(
      { err, episodeId: ctx.episodeId, entities: resolved.length },
      'entity vectors deferred; the entities are stored and the drain will embed them',
    );
    return true;
  }
}

export class EntityExtractionStage implements ReflectionStage {
  readonly name = ENTITY_STAGE_NAME;
  readonly #options: EntityStageOptions;

  constructor(options: Partial<EntityStageOptions> = {}) {
    this.#options = {
      model: DEFAULT_ENTITY_MODEL,
      timeoutMs: DEFAULT_ENTITY_TIMEOUT_MS,
      maxEntities: DEFAULT_MAX_ENTITIES,
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
