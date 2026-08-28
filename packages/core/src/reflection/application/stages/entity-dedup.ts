import {
  clearEntityVectors,
  findSimilarCurrentEntities,
  loadEntityDedupDetails,
  redirectAndAbsorb,
  type DedupEntityDetail,
} from '../../../infrastructure/graph/entity-dedup-queries.js';
import { findEpisodeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  entityMergeLedgerKey,
  groupDuplicates,
  mergeAccessCount,
  mergeAliases,
  mergeLastAccessed,
  selectCanonical,
  type DuplicatePair,
} from '../../domain/entity-merge.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * Whitepaper §6.5: after extraction, an entity is checked against the rest of the graph for a
 * near-duplicate identity — a name typed differently, a nickname, a casing extraction missed —
 * and duplicates collapse into one canonical node. Grouping and canonical selection are pure
 * (`reflection/domain/entity-merge.ts`); this stage does the graph reads that feed them and
 * the writes their decision requires.
 *
 * Scope is this episode's mentioned entities against the whole graph, matching §6.5's "newly
 * created entities are checked against existing graph residents" — not a full graph sweep,
 * which the maintenance operation catalog (P5) owns instead.
 */

export const ENTITY_DEDUP_STAGE_NAME = 'entity-dedup';

/** §6.5's pinned default. The Integration task threads a configured value into this field. */
export const DEFAULT_ENTITY_DEDUP_SIMILARITY_THRESHOLD = 0.85;

/** Enough to catch a genuine near-duplicate without turning one entity into a graph-wide scan. */
const CANDIDATE_SEARCH_LIMIT = 5;

/** Appendix C provenance for the merge edge `supersede` writes and the aliasing signal. */
export const ENTITY_DEDUP_METHOD = 'reflection_entity_dedup';

export type EntityDedupStageOptions = {
  readonly similarityThreshold: number;
};

export class EntityDedupStage implements ReflectionStage {
  readonly name = ENTITY_DEDUP_STAGE_NAME;
  readonly #options: EntityDedupStageOptions;

  constructor(options: Partial<EntityDedupStageOptions> = {}) {
    this.#options = {
      similarityThreshold: DEFAULT_ENTITY_DEDUP_SIMILARITY_THRESHOLD,
      ...options,
    };
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const mentioned = await findEpisodeEntities(ctx.driver, ctx.episodeId);
    if (mentioned.length === 0) {
      return { status: 'skipped', summary: 'episode mentions no entities to deduplicate' };
    }

    const subjectIds = [...new Set(mentioned.map((entity) => entity.id))];
    const details = new Map<string, DedupEntityDetail>();
    for (const detail of await loadEntityDedupDetails(ctx.driver, subjectIds)) {
      details.set(detail.id, detail);
    }

    const pairs = await this.#findDuplicatePairs(ctx, subjectIds, details);
    if (pairs.length === 0) {
      return { status: 'ok', summary: 'no near-duplicate entities found', counts: { merges: 0 } };
    }

    await this.#hydrateMissing(ctx, pairs, details);

    let merged = 0;
    let groupCount = 0;
    for (const group of groupDuplicates(pairs)) {
      const members = group
        .map((id) => details.get(id))
        .filter((detail): detail is DedupEntityDetail => detail !== undefined);
      if (members.length < 2) {
        continue;
      }

      const canonical = selectCanonical(members);
      const mergedIds = members.filter((member) => member.id !== canonical.id).map((member) => member.id);
      if (mergedIds.length === 0) {
        continue;
      }

      const key = entityMergeLedgerKey(canonical.id, mergedIds);
      if (isLedgerApplied(ctx.db, key)) {
        continue;
      }

      await this.#mergeGroup(ctx, canonical, members, mergedIds, key);
      merged += mergedIds.length;
      groupCount += 1;
    }

    return {
      status: 'ok',
      summary: `${merged} entities merged across ${groupCount} groups`,
      counts: { merges: merged },
    };
  }

  /** One similarity search per eligible subject; a subject already superseded or unvectorized cannot search. */
  async #findDuplicatePairs(
    ctx: StageContext,
    subjectIds: readonly string[],
    details: ReadonlyMap<string, DedupEntityDetail>,
  ): Promise<DuplicatePair[]> {
    const pairs: DuplicatePair[] = [];
    for (const id of subjectIds) {
      const subject = details.get(id);
      if (subject === undefined || !subject.current || subject.nameVector === undefined) {
        continue;
      }

      const matches = await findSimilarCurrentEntities(ctx.driver, {
        type: subject.type,
        excludeId: subject.id,
        vector: subject.nameVector,
        threshold: this.#options.similarityThreshold,
        limit: CANDIDATE_SEARCH_LIMIT,
      });
      for (const match of matches) {
        pairs.push({ a: subject.id, b: match.id });
      }
    }
    return pairs;
  }

  /** Candidates a similarity search turned up that were not already subjects need their own detail row. */
  async #hydrateMissing(
    ctx: StageContext,
    pairs: readonly DuplicatePair[],
    details: Map<string, DedupEntityDetail>,
  ): Promise<void> {
    const missing = [...new Set(pairs.flatMap((pair) => [pair.a, pair.b]))].filter(
      (id) => !details.has(id),
    );
    if (missing.length === 0) {
      return;
    }
    for (const detail of await loadEntityDedupDetails(ctx.driver, missing)) {
      details.set(detail.id, detail);
    }
  }

  /**
   * §6.5's atomic merge: redirect, absorb and close all commit together in
   * `redirectAndAbsorb`, so the group is never observable half-merged. Vector cleanup is the
   * one part deliberately outside it — §6.5 puts index cleanup post-commit with best-effort
   * semantics — and it never fails the stage. The ledger is written only once every graph
   * write above has committed.
   */
  async #mergeGroup(
    ctx: StageContext,
    canonical: DedupEntityDetail,
    members: readonly DedupEntityDetail[],
    mergedIds: readonly string[],
    ledgerKey: string,
  ): Promise<void> {
    await redirectAndAbsorb(ctx.driver, {
      canonicalId: canonical.id,
      mergedIds,
      aliases: mergeAliases(canonical.name, members),
      accessCount: mergeAccessCount(members),
      lastAccessed: mergeLastAccessed(members),
      supersedeSignals: ['entity_merge'],
      supersedeProvenance: [ENTITY_DEDUP_METHOD],
      now: ctx.now,
    });

    try {
      await clearEntityVectors(ctx.driver, mergedIds);
    } catch (err) {
      ctx.logger.warn(
        { err, canonicalId: canonical.id, mergedIds },
        'entity merge vector cleanup deferred',
      );
    }

    markLedgerApplied(ctx.db, ledgerKey, { canonicalId: canonical.id, mergedIds });
  }
}
