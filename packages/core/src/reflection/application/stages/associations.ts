import {
  findSimilarEntityCandidates,
  linkCoOccurrence,
  linkSimilarity,
} from '../../../infrastructure/graph/association-queries.js';
import { findEpisodeEntities, type EpisodeEntity } from '../../../infrastructure/graph/entity-queries.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { contentVectors } from '../../../infrastructure/graph/seed-queries.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { coOccurringPairs, coOccursLedgerKey } from '../../domain/associations.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * Entities that shared this episode get a `CO_OCCURS` edge; entities whose content vectors
 * are close, whether or not they ever shared an episode, get a `SIMILAR` edge. Both flow
 * through the edge-upsert merge policy in `association-queries.ts`; this stage is the pairing
 * and the idempotency gate around it, not the Cypher.
 *
 * Input comes from the graph, keyed on the episode, not from an earlier stage's output.
 * `findEpisodeEntities` returns `[]` when entity extraction has not run (or found nothing),
 * and that is simply nothing to associate, not an error.
 */

export const ASSOCIATION_STAGE_NAME = 'associations';

/** `config.AION_ASSOC_SEMANTIC_THRESHOLD`; callers thread the configured value in. */
export const DEFAULT_ASSOCIATION_SEMANTIC_THRESHOLD = 0.75;

/** How many `SIMILAR` candidates one entity can gain in a single run. */
export const DEFAULT_ASSOCIATION_SIMILAR_LIMIT = 5;

export type AssociationStageOptions = {
  readonly semanticThreshold: number;
  readonly similarLimit: number;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AssociationInferenceStage implements ReflectionStage {
  readonly name = ASSOCIATION_STAGE_NAME;
  readonly #options: AssociationStageOptions;

  constructor(options: Partial<AssociationStageOptions> = {}) {
    this.#options = {
      semanticThreshold: DEFAULT_ASSOCIATION_SEMANTIC_THRESHOLD,
      similarLimit: DEFAULT_ASSOCIATION_SIMILAR_LIMIT,
      ...options,
    };
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const entities = await this.#loadEntities(ctx);
    if (!entities.ok) {
      return { status: 'failed', summary: entities.summary };
    }
    if (entities.rows.length === 0) {
      return { status: 'skipped', summary: 'no entities mentioned in the episode' };
    }
    const entityIds = entities.rows.map((entity) => entity.id);

    const coOccurrence = await this.#linkCoOccurrences(ctx, entityIds);
    if (coOccurrence.status === 'failed') {
      return coOccurrence;
    }

    const similar = await this.#linkSimilarities(ctx, entityIds);
    if (similar.status === 'failed') {
      return {
        ...similar,
        counts: { associations: coOccurrence.written },
      };
    }

    return {
      status: 'ok',
      summary: `${coOccurrence.written} co-occurrence edge(s), ${similar.created} semantic edge(s)`,
      counts: { associations: coOccurrence.written + similar.created },
    };
  }

  async #loadEntities(
    ctx: StageContext,
  ): Promise<{ ok: true; rows: readonly EpisodeEntity[] } | { ok: false; summary: string }> {
    try {
      return { ok: true, rows: await findEpisodeEntities(ctx.driver, ctx.episodeId) };
    } catch (err) {
      return { ok: false, summary: `could not read episode entities: ${describe(err)}` };
    }
  }

  /**
   * Every co-occurring pair, gated once for the episode: a re-run, which is the orchestrator's
   * crash-before-ledger-mark case, leaves the edges' `count` untouched instead of
   * double-observing the same episode. The key is marked only after the last pair lands, so
   * an interrupted loop stays retryable rather than half-recorded and closed.
   */
  async #linkCoOccurrences(
    ctx: StageContext,
    entityIds: readonly string[],
  ): Promise<{ status: 'ok'; written: number } | { status: 'failed'; summary: string; counts: { associations: number } }> {
    const key = coOccursLedgerKey(ctx.episodeId);
    if (isLedgerApplied(ctx.db, key)) {
      return { status: 'ok', written: 0 };
    }

    const pairs = coOccurringPairs(entityIds);
    let written = 0;
    try {
      for (const pair of pairs) {
        await linkCoOccurrence(ctx.driver, {
          sourceId: pair.sourceId,
          targetId: pair.targetId,
          now: ctx.now,
        });
        written += 1;
      }
      markLedgerApplied(ctx.db, key, { pairs: written });
      return { status: 'ok', written };
    } catch (err) {
      return {
        status: 'failed',
        summary: `co-occurrence inference failed after writing ${written} of ${pairs.length} pair(s): ${describe(err)}`,
        counts: { associations: written },
      };
    }
  }

  /**
   * Semantic similarity is not episode-scoped, so it needs no ledger: `linkSimilarity`'s
   * `count: 0` already makes a repeat candidate a no-op, whether the repeat comes from this
   * run or a later one. An entity with no content vector yet (embedding deferred, per the
   * store-before-embed inversion) simply contributes no seed, which is a normal state, not a
   * failure.
   */
  async #linkSimilarities(
    ctx: StageContext,
    entityIds: readonly string[],
  ): Promise<{ status: 'ok'; created: number } | { status: 'failed'; summary: string }> {
    try {
      const seeds = await contentVectors(ctx.driver, { ids: entityIds, mode: withCurrency() });
      if (seeds.length === 0) {
        return { status: 'ok', created: 0 };
      }

      const candidates = await findSimilarEntityCandidates(ctx.driver, {
        entities: seeds,
        threshold: this.#options.semanticThreshold,
        limit: this.#options.similarLimit,
        mode: withCurrency(),
      });

      let created = 0;
      for (const candidate of candidates) {
        const result = await linkSimilarity(ctx.driver, {
          sourceId: candidate.sourceId,
          targetId: candidate.targetId,
          score: candidate.score,
          now: ctx.now,
        });
        if (result.created) {
          created += 1;
        }
      }
      return { status: 'ok', created };
    } catch (err) {
      return { status: 'failed', summary: `semantic similarity inference failed: ${describe(err)}` };
    }
  }
}
