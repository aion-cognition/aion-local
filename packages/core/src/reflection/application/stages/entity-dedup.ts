import {
  assembleEvidence,
  EntityDetailCache,
  findTier0Groups,
  nominatePairs,
  type NominatedPair,
} from './entity-dedup-cascade.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { DedupEntityDetail } from '../../../infrastructure/graph/entity-dedup-queries.js';
import { findEpisodeEntities } from '../../../infrastructure/graph/entity-queries.js';
import type { EntityMergeJudgeVerdicts } from '../../../infrastructure/sqlite/entity-merge-decisions.js';
import { recordEntityMergeProposal } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { describeEntityPairFacts, nameFormRelation } from '../../domain/entity-cascade.js';
import { selectCanonical } from '../../domain/entity-merge.js';
import { parseTypeCounts } from '../../domain/entity-reconciliation.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';
import {
  judgeEntityMerge,
  reviewEntityMerge,
  type EntityMergePair,
  type EntityMergeSide,
} from '../entity-merge-judge.js';
import { applyEntityMerge, collectMergeSignals } from '../entity-merge-writer.js';

/**
 * The entity dedup cascade, four tiers deep, run over the entities this episode mentioned.
 *
 * Tier 0 merges what the graph is already holding twice: two spellings of one name that the
 * `name_norm` uniqueness key cannot see, and an identity that already answers to another's name
 * as an alias. No model call, and a decision record all the same.
 *
 * Tier 1 nominates and decides nothing, from two independent directions: a name-vector search
 * per subject, and one bulk shared-episode pass that reaches the duplicates no vector compares.
 * Tier 2 measures what each nominated pair shares. Tier 3 puts the facts to a two-pass judge:
 * one call proposes, a second argues the other side on the same evidence, and only unanimity
 * merges. A pair the two passes split on lands as a proposal, which is the only thing that
 * fills that queue now.
 *
 * Type is evidence in the prompt and nothing else. It used to gate the merge path, and for as
 * long as two extractions disagreed about what kind of thing something was, its duplicate was
 * invisible: Postgres existed as tool, topic and organization at once with no run able to see
 * it. Type reconciliation on the surviving node is what settles the label afterwards.
 */

export const ENTITY_DEDUP_STAGE_NAME = 'entity-dedup';

/** Provenance for the merge edge `supersede` writes and the aliasing signal. */
export const ENTITY_DEDUP_METHOD = 'reflection_entity_dedup';

/** Provenance for a merge no model was asked about, so lineage says which tier decided. */
export const ENTITY_DEDUP_TIER0_METHOD = 'reflection_entity_dedup_tier0';

/**
 * What tier 3 does with a pair both passes called one thing. `unanimous` merges it; `propose`
 * queues it for a person and writes nothing to the graph, which is the kill switch.
 *
 * Tier 0 is outside the choice by construction. It asks no model, so there is no judgment for a
 * mode over judgments to gate, and a name that squashes onto another is the same name whichever
 * way the judge is running.
 */
export type EntityMergeMode = 'propose' | 'unanimous';

/** The pinned `AION_ENTITY_MERGE_MODE`, set by the battery's measurement rather than by hand. */
export const DEFAULT_ENTITY_MERGE_MODE: EntityMergeMode = DEFAULTS.reflection.entityMergeMode;

export type EntityDedupStageOptions = {
  readonly similarityThreshold: number;
  readonly sharedEpisodeJaccardFloor: number;
  readonly mode: EntityMergeMode;
  readonly model: string;
  readonly timeoutMs: number;
  /**
   * A run's ceiling on judged pairs, which is two model calls each at worst. Its own option
   * rather than a knob: every deployment has run the one number, and a stage that needs a
   * different guard takes it from its constructor.
   */
  readonly maxJudgments: number;
};

const DEFAULT_MAX_JUDGMENTS = 8;

/** What one run of the cascade did, summed across its tiers. */
type CascadeTally = {
  readonly merges: number;
  readonly groups: number;
  readonly proposals: number;
  readonly judged: number;
  /** Pairs tier 1 put forward, which is what `judged` has to be read against. */
  readonly nominated: number;
};

const NOTHING_DONE: CascadeTally = {
  merges: 0,
  groups: 0,
  proposals: 0,
  judged: 0,
  nominated: 0,
};

function addTallies(left: CascadeTally, right: CascadeTally): CascadeTally {
  return {
    merges: left.merges + right.merges,
    groups: left.groups + right.groups,
    proposals: left.proposals + right.proposals,
    judged: left.judged + right.judged,
    nominated: left.nominated + right.nominated,
  };
}

/** What one judged pair came to, before it is folded into the run's tally. */
type PairOutcome = { readonly tally: CascadeTally };

export class EntityDedupStage implements ReflectionStage {
  readonly name = ENTITY_DEDUP_STAGE_NAME;
  readonly #options: EntityDedupStageOptions;

  constructor(options: Partial<EntityDedupStageOptions> = {}) {
    this.#options = {
      similarityThreshold: DEFAULTS.reflection.entityDedupThreshold,
      sharedEpisodeJaccardFloor: DEFAULTS.reflection.entityNominationJaccardFloor,
      mode: DEFAULT_ENTITY_MERGE_MODE,
      model: DEFAULTS.models.reflect,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      maxJudgments: DEFAULT_MAX_JUDGMENTS,
      ...options,
    };
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const mentioned = await findEpisodeEntities(ctx.driver, ctx.episodeId);
    if (mentioned.length === 0) {
      return { status: 'skipped', summary: 'episode mentions no entities to deduplicate' };
    }

    const subjectIds = [...new Set(mentioned.map((entity) => entity.id))];
    const cache = new EntityDetailCache(ctx.driver);
    await cache.require(subjectIds);

    const tier0 = await this.#runTier0(ctx, cache, subjectIds);
    const judged = await this.#runJudgedTiers(ctx, cache, subjectIds);
    const tally = addTallies(tier0, judged);

    return {
      status: 'ok',
      summary:
        tally.merges === 0
          ? `no duplicate entities merged, ${String(tally.judged)} pair(s) judged in ` +
            `${this.#options.mode} mode`
          : `${String(tally.merges)} entities merged across ${String(tally.groups)} groups, ` +
            `${String(tally.judged)} pair(s) judged in ${this.#options.mode} mode`,
      counts: {
        merges: tally.merges,
        merge_proposals: tally.proposals,
        merge_judgments: tally.judged,
        merge_nominations: tally.nominated,
      },
    };
  }

  /** Tier 0: deterministic, model-free, and recorded exactly like a judged merge. */
  async #runTier0(
    ctx: StageContext,
    cache: EntityDetailCache,
    subjectIds: readonly string[],
  ): Promise<CascadeTally> {
    let tally = NOTHING_DONE;
    for (const group of await findTier0Groups(ctx.driver, cache, { subjectIds })) {
      const signals = await collectMergeSignals(ctx.driver, group.canonical, group.members);
      const result = await applyEntityMerge(
        { driver: ctx.driver, db: ctx.db, logger: ctx.logger },
        {
          canonical: group.canonical,
          members: group.members,
          tier: 'tier0',
          reasons: group.reasons,
          signals,
          method: ENTITY_DEDUP_TIER0_METHOD,
          now: ctx.now,
        },
      );
      if (result.status !== 'merged') {
        continue;
      }
      for (const id of result.mergedIds) {
        cache.absorb(id);
      }
      tally = addTallies(tally, {
        ...NOTHING_DONE,
        merges: result.mergedIds.length,
        groups: 1,
      });
    }
    return tally;
  }

  /**
   * Tiers 1 to 3. Every nominated pair is measured and then judged one pair at a time, because
   * a group merge decided by a chain of separate judgments claims an agreement no call made.
   * A side absorbed earlier in the same run drops out before its pair is spent on a model call.
   */
  async #runJudgedTiers(
    ctx: StageContext,
    cache: EntityDetailCache,
    subjectIds: readonly string[],
  ): Promise<CascadeTally> {
    const live = subjectIds.filter((id) => cache.isCurrent(id));
    if (live.length === 0) {
      return NOTHING_DONE;
    }
    const nominated = await nominatePairs(ctx.driver, cache, {
      subjectIds: live,
      similarityThreshold: this.#options.similarityThreshold,
      sharedEpisodeJaccardFloor: this.#options.sharedEpisodeJaccardFloor,
      logger: ctx.logger,
    });
    const evidence = await assembleEvidence(ctx.driver, nominated);
    const affordable = evidence.slice(0, this.#options.maxJudgments);
    // A run that could not afford its nominations says so. The dropped pairs write no proposal
    // and leave no other trace, so without this line the counts read as a quiet graph rather
    // than as a budget that ran out.
    if (evidence.length > affordable.length) {
      ctx.logger.info(
        {
          nominated: evidence.length,
          judged: affordable.length,
          unjudged: evidence.length - affordable.length,
        },
        'entity dedup judge budget spent before the nominations ran out',
      );
    }

    let tally: CascadeTally = { ...NOTHING_DONE, nominated: evidence.length };
    for (const pair of affordable) {
      if (!cache.isCurrent(pair.leftId) || !cache.isCurrent(pair.rightId)) {
        continue;
      }
      const outcome = await this.#judgePair(ctx, cache, pair);
      tally = addTallies(tally, outcome.tally);
    }
    return tally;
  }

  async #judgePair(
    ctx: StageContext,
    cache: EntityDetailCache,
    pair: NominatedPair,
  ): Promise<PairOutcome> {
    const left = cache.get(pair.leftId);
    const right = cache.get(pair.rightId);
    if (left === undefined || right === undefined) {
      return { tally: NOTHING_DONE };
    }

    const options = { model: this.#options.model, timeoutMs: this.#options.timeoutMs };
    const prompt = buildJudgePair(left, right, pair);
    const asked: CascadeTally = { ...NOTHING_DONE, judged: 1 };

    const detect = await judgeEntityMerge(ctx.provider, prompt, options);
    if (detect.status === 'failed') {
      ctx.logger.warn(
        { leftId: left.id, rightId: right.id, detail: detect.detail },
        'entity merge judge did not answer',
      );
      return { tally: asked };
    }
    if (!detect.judgment.same) {
      return { tally: asked };
    }

    const review = await reviewEntityMerge(ctx.provider, prompt, options);
    // An unanswered second pass is a split, not a pass: a merge the substrate cannot defend is
    // a merge it does not make, and the pair goes to the residue lane rather than through.
    if (review.status === 'failed' || !review.review.same) {
      this.#recordProposal(ctx, left, right, pair);
      return { tally: addTallies(asked, { ...NOTHING_DONE, proposals: 1 }) };
    }
    // The kill switch stops the write and nothing else. Both passes still run, so a deployment
    // holding the tier back keeps the queue it would have merged and the reasons behind it.
    if (this.#options.mode === 'propose') {
      this.#recordProposal(ctx, left, right, pair);
      return { tally: addTallies(asked, { ...NOTHING_DONE, proposals: 1 }) };
    }

    const merged = await this.#mergeJudged(ctx, cache, left, right, pair, {
      detect: detect.judgment,
      review: review.review,
    });
    return {
      tally: addTallies(asked, merged ? { ...NOTHING_DONE, merges: 1, groups: 1 } : NOTHING_DONE),
    };
  }

  async #mergeJudged(
    ctx: StageContext,
    cache: EntityDetailCache,
    left: DedupEntityDetail,
    right: DedupEntityDetail,
    pair: NominatedPair,
    judge: EntityMergeJudgeVerdicts,
  ): Promise<boolean> {
    const members = [left, right];
    const canonical = selectCanonical(members);
    const absorbed = canonical.id === left.id ? right : left;
    const cosines =
      pair.nominatingCosine === undefined
        ? new Map<string, number>()
        : new Map([[absorbed.id, pair.nominatingCosine]]);
    const signals = await collectMergeSignals(ctx.driver, canonical, members, cosines);

    const result = await applyEntityMerge(
      { driver: ctx.driver, db: ctx.db, logger: ctx.logger },
      {
        canonical,
        members,
        tier: 'tier3',
        reasons: [judge.detect.rationale, judge.review.rationale],
        signals,
        judge,
        method: ENTITY_DEDUP_METHOD,
        now: ctx.now,
      },
    );
    if (result.status !== 'merged') {
      return false;
    }
    for (const id of result.mergedIds) {
      cache.absorb(id);
    }
    return true;
  }

  /**
   * The residue lane. A pair the two passes split on is the one case left for a person, and it
   * is the only thing that writes here now: the cross-type queue this used to fill was an
   * artifact of an identity key that no longer exists.
   */
  #recordProposal(
    ctx: StageContext,
    left: DedupEntityDetail,
    right: DedupEntityDetail,
    pair: NominatedPair,
  ): void {
    // Whichever nominator put the pair forward, on its own scale, with the scale named beside
    // it. A pair the graph put forward has no cosine, and a set-overlap ratio stored in a
    // column every reader takes for a cosine is a number that lies quietly.
    const nominated =
      pair.nominatingCosine === undefined
        ? { similarity: pair.sharedEpisodeJaccard ?? 0, source: 'shared_episode_jaccard' as const }
        : { similarity: pair.nominatingCosine, source: 'name_cosine' as const };
    recordEntityMergeProposal(ctx.db, {
      subject: { id: left.id, name: left.name, type: left.type },
      candidate: { id: right.id, name: right.name, type: right.type },
      similarity: nominated.similarity,
      similaritySource: nominated.source,
      episodeId: ctx.episodeId,
      createdAt: ctx.now.toISOString(),
    });
  }
}

function toJudgeSide(detail: DedupEntityDetail): EntityMergeSide {
  const description = detail.description.trim();
  return {
    name: detail.name,
    aliases: detail.aliases,
    type: detail.type,
    typeCounts: parseTypeCounts(detail.typeCounts),
    ...(description.length === 0 ? {} : { description }),
  };
}

function buildJudgePair(
  left: DedupEntityDetail,
  right: DedupEntityDetail,
  pair: NominatedPair,
): EntityMergePair {
  return {
    subject: toJudgeSide(left),
    candidate: toJudgeSide(right),
    facts: describeEntityPairFacts({
      leftName: left.name,
      rightName: right.name,
      relation: nameFormRelation(left.name, right.name),
      leftMentionCount: left.mentionCount,
      rightMentionCount: right.mentionCount,
      ...(pair.signals === undefined ? {} : { signals: pair.signals }),
    }),
  };
}
