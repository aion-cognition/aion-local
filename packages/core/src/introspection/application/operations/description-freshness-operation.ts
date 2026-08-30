import { z } from 'zod';

import {
  findEntityMentionContexts,
  findStaleDescriptionEntities,
  refreshEntityDescription,
  type StaleDescriptionEntity,
} from '../../../infrastructure/graph/entity-description-queries.js';
import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * The parked C3, sanctioned as an introspector op: an entity's description is written once,
 * by whichever episode first named it, and ordinary extraction never revises it. Once enough
 * new mentions have accumulated, the description is a year-old sentence read as current fact
 * (`recall/domain/pack.ts` renders its age precisely because it never changes on its own).
 * This operation is the thing that changes it.
 */

export const DESCRIPTION_FRESHNESS_OPERATION = 'description_freshness';

/** How many recent mentioning episodes ground the re-synthesis prompt. */
const MENTION_CONTEXT_LIMIT = 5;
const MENTION_EXCERPT_CHARS = 400;
const DESCRIPTION_MAX_TOKENS = 300;

const DESCRIPTION_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { description: { type: 'string' } },
  required: ['description'],
};

const DescriptionSchema = z.object({ description: z.string() });

const SYSTEM_PROMPT = [
  "You maintain one entity's description in a personal memory system.",
  'You are given the description written when the entity was first mentioned, and episodes',
  'that have mentioned it since, most recent first.',
  'Write an updated description in one to two sentences that folds in anything the newer',
  'episodes add. State only what the current description or the episodes state; never invent',
  'a fact, cause, or relationship none of them contain.',
  'If the newer episodes add nothing worth keeping, answer with the current description',
  'unchanged.',
].join(' ');

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function buildMessages(
  entity: StaleDescriptionEntity,
  contexts: readonly { readonly text: string }[],
): ChatMessage[] {
  const mentions = contexts
    .map((context, index) => `[M${String(index + 1)}] ${clip(context.text, MENTION_EXCERPT_CHARS)}`)
    .join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Entity: ${entity.name} (${entity.type})\n` +
        `Current description: ${entity.text}\n\n` +
        `Newer mentions:\n${mentions}`,
    },
  ];
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
    relevance: () => DESCRIPTION_FRESHNESS_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      const batch = ctx.config.maintenance.descriptionRefreshBatch;
      const candidates = await findStaleDescriptionEntities(ctx.driver, {
        growthThreshold: ctx.config.maintenance.descriptionRefreshMentionGrowth,
        limit: batch,
      });

      let refreshed = 0;
      let failed = 0;

      for (const entity of candidates) {
        if (ctx.signal.aborted) {
          break;
        }
        const contexts = await findEntityMentionContexts(
          ctx.driver,
          entity.id,
          MENTION_CONTEXT_LIMIT,
        );

        let description: string;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => {
            controller.abort();
          }, ctx.config.reflection.stageTimeoutMs);
          try {
            const raw = await ctx.provider.generate({
              model: ctx.config.models.reflect,
              messages: buildMessages(entity, contexts),
              schema: DESCRIPTION_JSON_SCHEMA,
              maxTokens: DESCRIPTION_MAX_TOKENS,
              think: false,
              signal: controller.signal,
            });
            description = DescriptionSchema.parse(raw).description.trim();
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          failed += 1;
          ctx.logger.warn(
            { err, entityId: entity.id },
            'description freshness generation failed; leaving the description in place',
          );
          continue;
        }

        if (description.length === 0 || description === entity.text) {
          continue;
        }

        const [contentVector] = await ctx.provider.embed([description]);
        if (contentVector === undefined) {
          failed += 1;
          continue;
        }

        const applied = await refreshEntityDescription(ctx.driver, {
          id: entity.id,
          text: description,
          contentVector,
          mentionCount: entity.mentions,
          now: ctx.now,
        });
        if (applied) {
          refreshed += 1;
        }
      }

      return {
        status: refreshed === 0 ? 'noop' : 'applied',
        itemsProcessed: candidates.length,
        itemsAffected: refreshed,
        detail: `${String(refreshed)} of ${String(candidates.length)} stale description(s) refreshed, ${String(failed)} generation failure(s)`,
      };
    },
  };
}
