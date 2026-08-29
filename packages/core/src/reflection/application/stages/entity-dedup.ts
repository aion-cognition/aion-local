import {
  clearEntityVectors,
  findSimilarCurrentEntities,
  loadEntityDedupDetails,
  redirectAndAbsorb,
  type DedupEntityDetail,
} from '../../../infrastructure/graph/entity-dedup-queries.js';
import { findEpisodeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { recordEntityMergeProposal } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
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
import { nameFormMatches } from '../../domain/entity-identity.js';
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
 *
 * A merge needs two independent pieces of evidence, vector proximity and name form
 * (`reflection/domain/entity-identity.ts`), because either alone was measurably wrong: prose
 * similarity merged `gitlab-token` into `github-token`, and one constant embedding for whole
 * classes of out-of-vocabulary text collapsed eight distinct emoji entities into one.
 */

export const ENTITY_DEDUP_STAGE_NAME = 'entity-dedup';

/** §6.5's pinned default. The Integration task threads a configured value into this field. */
export const DEFAULT_ENTITY_DEDUP_SIMILARITY_THRESHOLD = 0.85;

/**
 * Enough to catch a genuine near-duplicate without turning one entity into a graph-wide scan.
 * Wider than the same-type search it replaced: the candidates now span every type, and one
 * real thing has been seen wearing four of them at once.
 */
const CANDIDATE_SEARCH_LIMIT = 8;

/** Appendix C provenance for the merge edge `supersede` writes and the aliasing signal. */
export const ENTITY_DEDUP_METHOD = 'reflection_entity_dedup';

export type EntityDedupStageOptions = {
  readonly similarityThreshold: number;
};

/** A same-type pair that cleared both legs, carried with the score the proposal path needs. */
type ScoredPair = DuplicatePair & {
  readonly score: number;
};

type CandidateSplit = {
  readonly pairs: ScoredPair[];
  readonly crossType: ScoredPair[];
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

    const split = await this.#findCandidates(ctx, subjectIds, details);
    const proposed = this.#recordCrossTypeProposals(ctx, split.crossType, details);
    if (split.pairs.length === 0) {
      return {
        status: 'ok',
        summary: 'no near-duplicate entities found',
        counts: { merges: 0, cross_type_proposals: proposed },
      };
    }

    let merged = 0;
    let groupCount = 0;
    for (const group of groupDuplicates(split.pairs)) {
      const members = group
        .map((id) => details.get(id))
        .filter((detail): detail is DedupEntityDetail => detail !== undefined);
      if (members.length < 2) {
        continue;
      }

      const canonical = selectCanonical(members);
      const merging = members.filter(
        (member) => member.id === canonical.id || nameFormMatches(canonical.name, member.name),
      );
      const mergedIds = merging.filter((member) => member.id !== canonical.id).map((member) => member.id);
      if (mergedIds.length === 0) {
        continue;
      }

      const key = entityMergeLedgerKey(canonical.id, mergedIds);
      if (isLedgerApplied(ctx.db, key)) {
        continue;
      }

      await this.#mergeGroup(ctx, canonical, merging, mergedIds, key);
      merged += mergedIds.length;
      groupCount += 1;
    }

    return {
      status: 'ok',
      summary: `${merged} entities merged across ${groupCount} groups`,
      counts: { merges: merged, cross_type_proposals: proposed },
    };
  }

  /**
   * One similarity search per eligible subject; a subject already superseded or unvectorized
   * cannot search. Every hit is then held to the name-form check before it counts as anything:
   * a candidate whose name the subject's name does not corroborate is neither a merge nor a
   * proposal, because the only evidence for it is a vector, and a vector alone is what put
   * `Redis` and `Valkey` inside one `Postgres` node.
   */
  async #findCandidates(
    ctx: StageContext,
    subjectIds: readonly string[],
    details: Map<string, DedupEntityDetail>,
  ): Promise<CandidateSplit> {
    const pairs: ScoredPair[] = [];
    const crossType: ScoredPair[] = [];

    for (const id of subjectIds) {
      const subject = details.get(id);
      if (subject === undefined || !subject.current || subject.nameVector === undefined) {
        continue;
      }

      const matches = await findSimilarCurrentEntities(ctx.driver, {
        excludeId: subject.id,
        vector: subject.nameVector,
        threshold: this.#options.similarityThreshold,
        limit: CANDIDATE_SEARCH_LIMIT,
      });
      await this.#hydrateMissing(ctx, matches.map((match) => match.id), details);

      for (const match of matches) {
        const candidate = details.get(match.id);
        if (candidate === undefined || !nameFormMatches(subject.name, candidate.name)) {
          continue;
        }
        const pair: ScoredPair = { a: subject.id, b: match.id, score: match.score };
        if (candidate.type === subject.type) {
          pairs.push(pair);
        } else {
          crossType.push(pair);
        }
      }
    }

    return { pairs, crossType };
  }

  /** Candidates a similarity search turned up that were not already subjects need their own detail row. */
  async #hydrateMissing(
    ctx: StageContext,
    ids: readonly string[],
    details: Map<string, DedupEntityDetail>,
  ): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !details.has(id));
    if (missing.length === 0) {
      return;
    }
    for (const detail of await loadEntityDedupDetails(ctx.driver, missing)) {
      details.set(detail.id, detail);
    }
  }

  /**
   * A cross-type near-duplicate is never merged. Uniqueness is on `(name_norm, type)`, so the
   * two nodes are separate identities and joining them means deciding which type the extraction
   * got wrong — a judgment about the world, not about strings. The pair lands as a proposal a
   * person resolves; nothing in the pipeline reads it back.
   */
  #recordCrossTypeProposals(
    ctx: StageContext,
    crossType: readonly ScoredPair[],
    details: ReadonlyMap<string, DedupEntityDetail>,
  ): number {
    let recorded = 0;
    for (const pair of crossType) {
      const subject = details.get(pair.a);
      const candidate = details.get(pair.b);
      if (subject === undefined || candidate === undefined) {
        continue;
      }
      recordEntityMergeProposal(ctx.db, {
        subject: { id: subject.id, name: subject.name, type: subject.type },
        candidate: { id: candidate.id, name: candidate.name, type: candidate.type },
        similarity: pair.score,
        episodeId: ctx.episodeId,
        createdAt: ctx.now.toISOString(),
      });
      recorded += 1;
    }
    return recorded;
  }

  /**
   * §6.5's atomic merge: redirect, absorb and close all commit together in
   * `redirectAndAbsorb`, so the group is never observable half-merged. Vector cleanup is the
   * one part deliberately outside it — §6.5 puts index cleanup post-commit with best-effort
   * semantics — and it never fails the stage. The ledger is written only once every graph
   * write above has committed.
   *
   * `mergedRecords` is what makes the merge reversible: the absorbed node's own identity, and
   * (built inside the transaction) the edges it carried, land on the canonical. The unmerge
   * operation is P5 maintenance and the data has to be written now, because a redirected edge
   * that collides with one the canonical already held sums into it and stops being separable.
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
      mergedRecords: members
        .filter((member) => member.id !== canonical.id)
        .map((member) => ({
          id: member.id,
          name: member.name,
          nameNorm: member.nameNorm,
          type: member.type,
          aliases: member.aliases,
        })),
      ledgerKey,
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
