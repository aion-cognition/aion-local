import { z } from 'zod';

import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import {
  findEntityMentionContexts,
  findUndescribedEntities,
  stampCuriosityAsked,
  type UndescribedEntity,
} from '../../../infrastructure/graph/entity-description-queries.js';
import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Vector } from '../../../infrastructure/providers/types.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { recordLifecycleEvent } from '../../../reflection/application/lifecycle-events.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * A well-connected entity the substrate cannot describe is a hole it can see from the inside.
 * `curiosity` turns one into a question and files it as the substrate's own standing intention:
 * a Goal marked `substrate`, keyed to the entity, which comes back the next time that entity is
 * in play rather than the next time somebody thinks to ask.
 *
 * It is the one operation that writes memory rather than only editing the graph, so the question
 * goes through intake as a system episode first and the Goal hangs off that episode. An episode
 * that failed to record costs the entity its turn: a Goal pointing at nothing has no provenance,
 * no `aion why`, and nothing for a forget to take with it.
 *
 * Closure needs nothing of its own. A later intention sharing the key replaces the question, and
 * one nobody ever answers is closed as abandoned by the horizon sweep, which is what an
 * unanswered question deserves.
 */

export const CURIOSITY_OPERATION = 'curiosity';

export const CURIOSITY_LEDGER_PREFIX = 'curiosity:';

/** Its own namespace, per entity asked about, beside the engine's own bucket key for the run. */
export function curiosityLedgerKey(entityId: string): string {
  return `${CURIOSITY_LEDGER_PREFIX}${entityId}`;
}

/**
 * The aspect every question keys under. All the substrate's questions about one entity are one
 * slot, so a later one replaces the earlier rather than stacking two open questions about the
 * same hole. It is written in folded form, which a unit test pins, because the key only matches
 * what the fold produces.
 */
export const CURIOSITY_ASPECT = 'open question';

/**
 * Standing relevance, like `intention_upkeep`: no health snapshot counts entities the substrate
 * cannot describe, so the operation reaches the urgency threshold on waiting time. Low, because
 * on most days there is either nothing to ask about or the day's two questions are already out.
 */
export const CURIOSITY_STANDING_RELEVANCE = 0.1;

/**
 * Mentions a described-once entity needs before a gloss nothing re-derived counts as a hole.
 * The same figure description freshness uses for its own growth bar, for the same reason: five
 * appearances is enough traffic that a sentence written at the first one is plainly behind.
 * An entity whose gloss a correction retired needs no such bar, since it says nothing at all.
 */
const CURIOSITY_MENTION_FLOOR = 5;

/** How many recent mentioning episodes ground the question. */
const MENTION_CONTEXT_LIMIT = 5;
const MENTION_EXCERPT_CHARS = 400;
const QUESTION_MAX_TOKENS = 200;

/**
 * Named rather than left to the route's default. The question is stored text a later session
 * reads as the substrate's own words, so one entity reads one way.
 */
const QUESTION_TEMPERATURE = 0;

const QUESTION_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { question: { type: 'string' } },
  required: ['question'],
};

const QuestionSchema = z.object({ question: z.string() });

const SYSTEM_PROMPT = [
  'You write one question a personal memory system will put to its member later.',
  'You are given an entity the system keeps seeing and cannot describe, and episodes that',
  'mention it, most recent first.',
  'Write one plain question, a single sentence, that would get the member to say what this is',
  'and why it keeps coming up.',
  'Name the entity in the question. Whoever reads it will have none of this context, so a',
  'pronoun or a "this" resolves to nothing.',
  'Ask about what the episodes leave open; never assume a fact none of them state.',
].join(' ');

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * What the substrate asks when the model is down, slow, or answers with something unusable. It
 * is a floor rather than the design: it names the entity and asks the two things the selection
 * read already established nobody has said, which is the least a stored question has to do.
 */
export function fallbackQuestion(entity: { readonly name: string }): string {
  return `What is ${entity.name}, and why does it keep coming up?`;
}

function buildMessages(
  entity: UndescribedEntity,
  contexts: readonly { readonly text: string }[],
): ChatMessage[] {
  const mentions = contexts
    .map((context, index) => `[M${String(index + 1)}] ${clip(context.text, MENTION_EXCERPT_CHARS)}`)
    .join('\n\n');
  const known = entity.text === '' ? 'nothing on file' : entity.text;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Entity: ${entity.name} (${entity.type})\n` +
        `What the system currently says about it: ${known}\n` +
        `Mentions on file: ${String(entity.mentions)}\n\n` +
        `Recent mentions:\n${mentions}`,
    },
  ];
}

/**
 * A question that does not name what it is about is worse than the deterministic one: it lands
 * in a later session as a line with no referent, and the session has no way back to the entity
 * that prompted it.
 */
function namesEntity(question: string, entity: UndescribedEntity): boolean {
  return question.toLowerCase().includes(entity.name.toLowerCase());
}

async function draftQuestion(
  ctx: OperationContext,
  entity: UndescribedEntity,
  contexts: readonly { readonly text: string }[],
): Promise<string> {
  const fallback = fallbackQuestion(entity);
  const deadline = deadlineFor(ctx.config.reflection.stageTimeoutMs, ctx.signal);
  try {
    const raw = await ctx.provider.generate({
      model: ctx.config.models.reflect,
      messages: buildMessages(entity, contexts),
      schema: QUESTION_JSON_SCHEMA,
      maxTokens: QUESTION_MAX_TOKENS,
      temperature: QUESTION_TEMPERATURE,
      think: false,
      signal: deadline.signal,
    });
    const question = QuestionSchema.parse(raw).question.trim();
    if (question.length === 0 || !namesEntity(question, entity)) {
      return fallback;
    }
    return question;
  } catch (err) {
    ctx.logger.warn(
      { err, entityId: entity.id },
      'curiosity question generation failed; filing the deterministic question',
    );
    return fallback;
  } finally {
    deadline.clear();
  }
}

/**
 * Embedded before the episode is recorded, so an embedder that is down costs nothing yet. A
 * missing vector is not a reason to skip: the node lands the way any pending-vector node lands
 * and `vector_backfill` fills it in, while the trigger that matters here is the subject key.
 */
async function embedQuestion(ctx: OperationContext, question: string): Promise<Vector | undefined> {
  try {
    const [vector] = await ctx.provider.embed([question]);
    return vector;
  } catch (err) {
    ctx.logger.warn({ err }, 'curiosity question left unembedded; vector backfill will take it');
    return undefined;
  }
}

function noop(detail: string): OperationOutcome {
  return { status: 'noop', itemsProcessed: 0, itemsAffected: 0, detail };
}

async function askAbout(ctx: OperationContext, entity: UndescribedEntity): Promise<boolean> {
  const { intake } = ctx;
  if (intake === undefined) {
    return false;
  }
  const contexts = await findEntityMentionContexts(ctx.driver, entity.id, MENTION_CONTEXT_LIMIT);
  const question = await draftQuestion(ctx, entity, contexts);
  const contentVector = await embedQuestion(ctx, question);

  const episodeId = await recordLifecycleEvent(intake, {
    event: 'curiosity',
    text: question,
    now: ctx.now,
  });
  if (episodeId === undefined) {
    ctx.logger.warn(
      { entityId: entity.id },
      'curiosity question not recorded; leaving the entity for a later run',
    );
    return false;
  }

  const written = await writeCognitiveNode(ctx.driver, {
    episodeId,
    label: 'Goal',
    text: question,
    occurredAt: ctx.now,
    now: ctx.now,
    // The subject is the whole trigger: the question comes back when the entity it asks about
    // is in play, which is the only moment anyone can answer it.
    subjectEntityId: entity.id,
    aspectNorm: CURIOSITY_ASPECT,
    intentionHorizonDays: ctx.config.temporal.intentionHorizonDays,
    originKind: 'substrate',
    ...(contentVector === undefined ? {} : { contentVector }),
  });

  await stampCuriosityAsked(ctx.driver, { id: entity.id, now: ctx.now });
  markLedgerApplied(ctx.db, curiosityLedgerKey(entity.id), {
    askedAt: ctx.now.toISOString(),
    goalId: written.node.id,
    episodeId,
    mentions: entity.mentions,
  });
  return true;
}

async function runCuriosity(ctx: OperationContext): Promise<OperationOutcome> {
  if (!ctx.config.maintenance.curiosity) {
    return noop('curiosity disabled by AION_MAINTENANCE_CURIOSITY; no entity examined');
  }
  if (ctx.intake === undefined) {
    return noop('curiosity has no intake path to record a question through; no entity examined');
  }

  const candidates = await findUndescribedEntities(ctx.driver, {
    mentionFloor: CURIOSITY_MENTION_FLOOR,
    limit: ctx.config.maintenance.curiosityBatch,
  });

  let asked = 0;
  for (const entity of candidates) {
    if (ctx.signal.aborted) {
      break;
    }
    if (await askAbout(ctx, entity)) {
      asked += 1;
    }
  }

  return {
    status: asked === 0 ? 'noop' : 'applied',
    itemsProcessed: candidates.length,
    itemsAffected: asked,
    detail:
      `filed ${String(asked)} question(s) over ${String(candidates.length)} ` +
      'candidate(s) the substrate cannot describe',
  };
}

export function curiosityOperation(): IntrospectionOperation {
  return {
    name: CURIOSITY_OPERATION,
    bucket: 'day',
    enabled: (config) => config.maintenance.curiosity,
    relevance: () => CURIOSITY_STANDING_RELEVANCE,
    run: runCuriosity,
  };
}
