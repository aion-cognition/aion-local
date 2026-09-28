import { z } from 'zod';

import {
  findEntityMentionContexts,
  findStaleDescriptionEntities,
  mentionSourceDigest,
  quotedMentionSources,
  readableMentionSources,
  readEntityDescriptionState,
  refreshEntityDescription,
  type StaleDescriptionEntity,
} from '../../../infrastructure/graph/entity-description-queries.js';
import { batchMessagesBody } from '../../../infrastructure/providers/anthropic-provider.js';
import type { BatchWorkHandler } from '../../../infrastructure/providers/batch-adapter.js';
import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
import {
  enqueueBatchWork,
  reopenDiscardedBatchWork,
  type BatchWorkItem,
} from '../../../infrastructure/sqlite/batch-work.js';
import { readSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import { FRESHNESS_PROMPT, MAX_TOKENS } from '../../../prompts/description-freshness.js';
import { FRAME_VERSION } from '../../../prompts/frame.js';
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
 * `sourceDigest` carries what those episodes said. A readable id is not the input the model was
 * given: the residue purge rewrites an episode's text in place and leaves the id readable, and an
 * answer quoting the plaintext it replaced is about a sentence the store no longer holds.
 */
const RevalidationSchema = z.object({
  entityId: z.string().min(1),
  baseline: z.number().int().nonnegative(),
  mentions: z.number().int().nonnegative(),
  text: z.string(),
  sources: z.array(z.string().min(1)).min(1),
  sourceDigest: z.string().min(1),
});

type FreshnessRevalidation = z.infer<typeof RevalidationSchema>;

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
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
 * the prompt quotes, as it quotes them.
 *
 * Stable, so a nomination the next pass makes again finds the row it already wrote instead of
 * paying for the same question twice. It moves the moment any input does, so an entity whose
 * gloss a correction retired, whose baseline another refresh advanced, that has been mentioned
 * somewhere new, or whose quoted evidence was rewritten is a new question rather than one a
 * terminal row blocks forever. The evidence belongs in it for the answer that changes nothing:
 * that answer leaves the gloss and the baseline where they were and settles the row, and without
 * the mentions in the identity there would be no question left to ask once new ones arrived.
 */
export function descriptionFreshnessDurableKey(
  entity: StaleDescriptionEntity,
  sourceDigest: string,
): string {
  return [
    DESCRIPTION_FRESHNESS_SURFACE,
    entity.id,
    String(entity.baseline),
    String(entity.mentions),
    hashContent(entity.text),
    sourceDigest,
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
      // The batch lane is Anthropic's Message Batches API. With background generation routed
      // elsewhere, sending this work to it would answer on a model the operator did not select.
      if (ctx.config.generation.reflectProvider !== 'anthropic') {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail:
            `batched description refresh runs on the Anthropic batch route, and ` +
            `AION_REFLECT_PROVIDER=${ctx.config.generation.reflectProvider}; no entity examined`,
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
        const sourceDigest = mentionSourceDigest(contexts);
        const revalidation: FreshnessRevalidation = {
          entityId: entity.id,
          baseline: entity.baseline,
          mentions: entity.mentions,
          text: entity.text,
          sources,
          sourceDigest,
        };
        const durableKey = descriptionFreshnessDurableKey(entity, sourceDigest);
        const workKey = descriptionFreshnessWorkKey(durableKey);
        const wrote = enqueueBatchWork(ctx.db, {
          workKey,
          durableKey,
          substrateId: substrate.substrateId,
          surface: DESCRIPTION_FRESHNESS_SURFACE,
          revalidation,
          request: batchMessagesBody({
            surface: DESCRIPTION_FRESHNESS_SURFACE,
            model: ctx.config.anthropic.model,
            messages: buildMessages(entity, contexts, FRESHNESS_PROMPT),
            schema: DESCRIPTION_JSON_SCHEMA,
            maxTokens: MAX_TOKENS,
            temperature: DESCRIPTION_TEMPERATURE,
            think: false,
          }),
          // Recorded beside the body rather than derived from it. The body is replayed verbatim,
          // so a bump to the frame does not reach a request already outstanding, and this is what
          // says which frame that request was written under.
          frameVersion: FRAME_VERSION,
          now: ctx.now,
        });
        // A discarded row carries the same key only when every input this nomination just read is
        // the one the discarded question was asked about, down to what its sources say. The
        // answer was thrown away because something moved while it was at the remote, and this
        // read is the proof that it moved back, so the question is owed again rather than closed
        // by a row nobody can clear.
        if (wrote || reopenDiscardedBatchWork(ctx.db, workKey, substrate.substrateId, ctx.now)) {
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
 * whose own grounding mentions are no longer readable or no longer say what it read.
 *
 * `apply` does not trust that reading to survive the embed it takes next. The gloss the answer
 * revised and the sources it was grounded in, with what they said, go into the guarded write
 * itself, so a description
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
      // current: the sentence it produced rests on the one that went. What they say is read
      // with them, because an episode rewritten in place is as gone as one that was forgotten.
      const readable = await readableMentionSources(
        ctx.driver,
        parsed.data.entityId,
        parsed.data.sources,
      );
      const quoted = quotedMentionSources(parsed.data.sources, readable);
      return quoted !== undefined && mentionSourceDigest(quoted) === parsed.data.sourceDigest;
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
        expectedSourceDigest: revalidation.sourceDigest,
      });
      if (!applied) {
        // The guarded write is the last word, and it matched nothing: the entity was closed, its
        // gloss moved under the embed above, or one of the sources this answer rests on was
        // forgotten or rewritten. The work stays owed, and the next nomination asks about what is
        // there now.
        throw new Error(
          `the question about entity ${revalidation.entityId} moved under its answer`,
        );
      }
    },
  };
}
