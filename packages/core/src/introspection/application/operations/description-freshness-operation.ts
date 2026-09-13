import { z } from 'zod';

import {
  findEntityMentionContexts,
  findStaleDescriptionEntities,
  readableMentionSources,
  readEntityDescriptionState,
  refreshEntityDescription,
  type StaleDescriptionEntity,
} from '../../../infrastructure/graph/entity-description-queries.js';
import { batchMessagesBody } from '../../../infrastructure/providers/anthropic-provider.js';
import type { BatchWorkHandler } from '../../../infrastructure/providers/batch-adapter.js';
import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
import { enqueueBatchWork, type BatchWorkItem } from '../../../infrastructure/sqlite/batch-work.js';
import { readSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import {
  KEYED as FRESHNESS_KEYED,
  KEYED_MAX_TOKENS,
  LOCAL as FRESHNESS_LOCAL,
  LOCAL_MAX_TOKENS,
} from '../../../prompts/description-freshness.js';
import { promptMode, type PromptMode } from '../../../prompts/index.js';
import { hashContent } from '../../../reflection/domain/content.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * An entity's description is written once, by whichever episode first named it, and ordinary
 * extraction never revises it. Once enough new mentions have accumulated, the description is
 * a year-old sentence read as current fact (`recall/domain/pack.ts` renders its age precisely
 * because it never changes on its own). This operation is the thing that changes it.
 *
 * It is the substrate's first batch producer, and it is the right first one: nobody is waiting
 * for a gloss to be rewritten, every input is ready before the request is built, and the write at
 * the end is already guarded. The run nominates and enqueues; the `batch_settlement` operation
 * sends what is owed and hands each answer back to the handler below, which revalidates it
 * against the substrate and applies it. Submission is not completion, so nothing here counts a
 * description as refreshed until the write says it wrote one.
 *
 * It carries its own kill switch. Every other operation either closes a node and writes a new
 * one or moves a number; this one replaces stored text with model output in place, so an
 * operator who wants the rewrite stopped needs a knob rather than a deploy.
 */

export const DESCRIPTION_FRESHNESS_OPERATION = 'description_freshness';

/** The surface a batched refresh is enqueued under, and the surface its bill is grouped by. */
export const DESCRIPTION_FRESHNESS_SURFACE = 'description_freshness';

/** How many recent mentioning episodes ground the re-synthesis prompt. */
const MENTION_CONTEXT_LIMIT = 5;
const MENTION_EXCERPT_CHARS = 400;

/**
 * Named rather than left to the route's default, which the provider no longer sends. The
 * operation rewrites a description in place from mentions it just read, so a second pass over
 * unchanged mentions leaves the entity alone.
 */
const DESCRIPTION_TEMPERATURE = 0;

const DESCRIPTION_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { description: { type: 'string' } },
  required: ['description'],
};

const DescriptionSchema = z.object({ description: z.string() });

/**
 * What the entity looked like where the request was built, read back before the answer is used.
 *
 * `baseline` moves whenever anything refreshes the description, and the gloss itself is carried
 * whole rather than as a count, because a correction can retire it without moving any number.
 * `mentions` is the count the refresh writes as the new baseline, so it has to be the count the
 * prompt was grounded in rather than whatever the entity has reached by the time it lands.
 * `sources` names the episodes the prompt actually quoted, which is what the answer is about: an
 * entity that still has mentions is not the same fact as an entity that still has these ones.
 */
const RevalidationSchema = z.object({
  entityId: z.string().min(1),
  baseline: z.number().int().nonnegative(),
  mentions: z.number().int().nonnegative(),
  text: z.string(),
  sources: z.array(z.string().min(1)).min(1),
});

type FreshnessRevalidation = z.infer<typeof RevalidationSchema>;

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

type FreshnessPrompt = {
  readonly system: string;
  readonly maxTokens: number;
};

/**
 * Text and budget travel together, since the number is only ever the room the words ask for: the
 * keyed prompt wants three to four sentences naming connections, the local one wants two.
 */
function promptFor(mode: PromptMode): FreshnessPrompt {
  if (mode === 'keyed') {
    return { system: FRESHNESS_KEYED, maxTokens: KEYED_MAX_TOKENS };
  }
  return { system: FRESHNESS_LOCAL, maxTokens: LOCAL_MAX_TOKENS };
}

function buildMessages(
  entity: StaleDescriptionEntity,
  contexts: readonly { readonly text: string }[],
  system: string,
): ChatMessage[] {
  const mentions = contexts
    .map((context, index) => `[M${String(index + 1)}] ${clip(context.text, MENTION_EXCERPT_CHARS)}`)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content:
        `Entity: ${entity.name} (${entity.type})\n` +
        `Current description: ${entity.text}\n\n` +
        `Newer mentions:\n${mentions}`,
    },
  ];
}

/** How much of the question's digest the remote id carries. Collision-free at this population. */
const WORK_KEY_DIGEST_CHARS = 32;

/**
 * The remote id every question of this surface carries. Letters, digits and a hyphen, well inside
 * the sixty-four characters the batch API accepts.
 */
const REMOTE_ID_PREFIX = 'df-';

/**
 * The identity of one question: this entity, this gloss, this baseline, and the exact mentions
 * the prompt quotes.
 *
 * Stable, so a nomination the next pass makes again finds the row it already wrote instead of
 * paying for the same question twice. It moves the moment any input does, so an entity whose
 * gloss a correction retired, whose baseline another refresh advanced, or that has been mentioned
 * somewhere new is a new question rather than one a terminal row blocks forever. The evidence
 * belongs in it for the answer that changes nothing: that answer leaves the gloss and the
 * baseline where they were and settles the row, and without the mentions in the identity there
 * would be no question left to ask once new ones arrived.
 */
export function descriptionFreshnessDurableKey(
  entity: StaleDescriptionEntity,
  sources: readonly string[],
): string {
  return [
    DESCRIPTION_FRESHNESS_SURFACE,
    entity.id,
    String(entity.baseline),
    String(entity.mentions),
    hashContent(entity.text),
    hashContent(sources),
  ].join(':');
}

/**
 * The remote id for that question. The durable key above carries colons and runs past sixty-four
 * characters, and the API accepts neither, so what goes on the wire is a digest of it and the
 * work row keeps the key itself.
 */
export function descriptionFreshnessWorkKey(durableKey: string): string {
  return `${REMOTE_ID_PREFIX}${hashContent(durableKey).slice(0, WORK_KEY_DIGEST_CHARS)}`;
}

/**
 * Standing relevance, like `memory_decay`: candidates are counted fresh inside `run`, not
 * carried in the health snapshot, so relevance answers from the same waiting-time cadence
 * rather than a live count observe.ts would have to add a group for.
 */
export const DESCRIPTION_FRESHNESS_STANDING_RELEVANCE = 0.15;

export function descriptionFreshnessOperation(): IntrospectionOperation {
  return {
    name: DESCRIPTION_FRESHNESS_OPERATION,
    bucket: 'hour',
    enabled: (config) => config.maintenance.descriptionFreshness,
    relevance: () => DESCRIPTION_FRESHNESS_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      if (!ctx.config.maintenance.descriptionFreshness) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail:
            'description freshness disabled by AION_MAINTENANCE_DESCRIPTION_FRESHNESS; no entity examined',
        };
      }
      const substrate = readSubstratePairing(ctx.db);
      if (substrate === undefined) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'no substrate identity, so batched work would belong to no store',
        };
      }

      const prompt = promptFor(promptMode(ctx.provider));
      const batch = ctx.config.maintenance.descriptionRefreshBatch;
      const candidates = await findStaleDescriptionEntities(ctx.driver, {
        growthThreshold: ctx.config.maintenance.descriptionRefreshMentionGrowth,
        limit: batch,
      });

      let enqueued = 0;
      let held = 0;

      for (const entity of candidates) {
        if (ctx.signal.aborted) {
          break;
        }
        const contexts = await findEntityMentionContexts(
          ctx.driver,
          entity.id,
          MENTION_CONTEXT_LIMIT,
        );
        if (contexts.length === 0) {
          // Nothing newer to fold in that a reader can still see. The growth count includes
          // mentions from episodes a forget has since closed, and a prompt grounded in none of
          // them would ask the model to rewrite a gloss from the gloss.
          held += 1;
          continue;
        }
        const sources = contexts.map((context) => context.episodeId);
        const revalidation: FreshnessRevalidation = {
          entityId: entity.id,
          baseline: entity.baseline,
          mentions: entity.mentions,
          text: entity.text,
          sources,
        };
        const durableKey = descriptionFreshnessDurableKey(entity, sources);
        const wrote = enqueueBatchWork(ctx.db, {
          workKey: descriptionFreshnessWorkKey(durableKey),
          durableKey,
          substrateId: substrate.substrateId,
          surface: DESCRIPTION_FRESHNESS_SURFACE,
          revalidation,
          request: batchMessagesBody({
            surface: DESCRIPTION_FRESHNESS_SURFACE,
            model: ctx.config.anthropic.model,
            messages: buildMessages(entity, contexts, prompt.system),
            schema: DESCRIPTION_JSON_SCHEMA,
            maxTokens: prompt.maxTokens,
            temperature: DESCRIPTION_TEMPERATURE,
            think: false,
          }),
          now: ctx.now,
        });
        if (wrote) {
          enqueued += 1;
        }
      }

      return {
        status: enqueued === 0 ? 'noop' : 'applied',
        itemsProcessed: candidates.length,
        itemsAffected: enqueued,
        detail:
          `${String(enqueued)} of ${String(candidates.length)} stale description(s) enqueued for ` +
          `batched re-synthesis, ${String(held)} held for want of readable mentions; ` +
          'a description is refreshed when its answer lands, not when it is asked for',
      };
    },
  };
}

/**
 * What the surface does with its own answers.
 *
 * Both halves take the run's own driver and provider, so the embed and the write are the ones the
 * loop would have made inline. `isCurrent` is a real reading of the substrate rather than a
 * formality: it refuses an answer about a gloss that has moved, an entity that has gone, and one
 * whose own grounding mentions are no longer readable.
 *
 * `apply` does not trust that reading to survive the embed it takes next. The gloss the answer
 * revised and the sources it was grounded in go into the guarded write itself, so a description
 * another pass committed in that window keeps the node and the older answer is owed again rather
 * than published over it.
 */
export function descriptionFreshnessHandler(ctx: OperationContext): BatchWorkHandler {
  return {
    surface: DESCRIPTION_FRESHNESS_SURFACE,
    isCurrent: async (_db, revalidation): Promise<boolean> => {
      const parsed = RevalidationSchema.safeParse(revalidation);
      if (!parsed.success) {
        return false;
      }
      const state = await readEntityDescriptionState(ctx.driver, parsed.data.entityId);
      if (state === undefined) {
        return false;
      }
      if (state.baseline !== parsed.data.baseline || state.text !== parsed.data.text) {
        return false;
      }
      // The sources the prompt quoted, not a count of what the entity still has. An answer
      // written from five episodes is about those five, and four survivors do not make it
      // current: the sentence it produced rests on the one that went.
      const readable = await readableMentionSources(
        ctx.driver,
        parsed.data.entityId,
        parsed.data.sources,
      );
      return readable.length === new Set(parsed.data.sources).size;
    },
    apply: async (item: BatchWorkItem, answer: unknown): Promise<void> => {
      const revalidation = RevalidationSchema.parse(item.revalidation);
      const description = DescriptionSchema.parse(answer).description.trim();
      if (description.length === 0 || description === revalidation.text) {
        // An answer, and a complete one: the model read the newer mentions and had nothing to
        // add. The row settles applied because the question is answered, and the entity keeps
        // the gloss it had.
        ctx.logger.debug(
          { entityId: revalidation.entityId },
          'batched description refresh returned the gloss the entity already has',
        );
        return;
      }
      const [contentVector] = await ctx.provider.embed([description]);
      if (contentVector === undefined) {
        throw new Error('the embedder returned no vector for the refreshed description');
      }
      const applied = await refreshEntityDescription(ctx.driver, {
        id: revalidation.entityId,
        text: description,
        contentVector,
        mentionCount: revalidation.mentions,
        now: ctx.now,
        expectedText: revalidation.text,
        sources: revalidation.sources,
      });
      if (!applied) {
        // The guarded write is the last word, and it matched nothing: the entity was closed, its
        // gloss moved under the embed above, or one of the sources this answer rests on was
        // forgotten. The work stays owed, and the next nomination asks about what is there now.
        throw new Error(
          `the question about entity ${revalidation.entityId} moved under its answer`,
        );
      }
    },
  };
}
