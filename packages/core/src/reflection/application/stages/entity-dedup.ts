import {
  assembleEvidence,
  EntityDetailCache,
  findTier0Groups,
  nominatePairs,
  type NominatedPair,
} from './entity-dedup-cascade.js';
import { buildJudgePair, entityJudgmentPair, withEvidence } from './entity-dedup-prompt.js';
import { addTallies, NOTHING_DONE, type CascadeTally } from './entity-dedup-tally.js';
import {
  judgmentEvidenceFor,
  withheldWorkFor,
  type JudgmentEvidenceOutcome,
  type WithheldWork,
} from '../../../evidence/application/judgment.js';
import { idAddress } from '../../../evidence/domain/address.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { DedupEntityDetail } from '../../../infrastructure/graph/entity-dedup-queries.js';
import { findEpisodeEntities } from '../../../infrastructure/graph/entity-queries.js';
import type { EntityMergeJudgeVerdicts } from '../../../infrastructure/sqlite/entity-merge-decisions.js';
import { recordEntityMergeProposal } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { selectCanonical } from '../../domain/entity-merge.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';
import {
  ENTITY_MERGE_OVER_ALLOWANCE,
  ENTITY_MERGE_ROUTE_RESERVE,
  judgeEntityMerge,
  reviewEntityMerge,
} from '../entity-merge-judge.js';
import { applyEntityMerge, collectMergeSignals } from '../entity-merge-writer.js';
import { evidenceMoved, movedWork } from '../evidence-fence.js';

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
 * files it as a proposal for `proposal_resolution` to decide and writes nothing to the graph
 * here, which is the kill switch.
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

/** What one judged pair came to, before it is folded into the run's tally. */
type PairOutcome = { readonly tally: CascadeTally; readonly work?: WithheldWork };

export class EntityDedupStage implements ReflectionStage {
  readonly name = ENTITY_DEDUP_STAGE_NAME;
  readonly #options: EntityDedupStageOptions;

  constructor(options: Partial<EntityDedupStageOptions> = {}) {
    this.#options = {
      similarityThreshold: DEFAULTS.reflection.entityDedupThreshold,
      sharedEpisodeJaccardFloor: DEFAULTS.reflection.entityNominationJaccardFloor,
      mode: DEFAULT_ENTITY_MERGE_MODE,
      model: DEFAULTS.anthropic.model,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      maxJudgments: DEFAULT_MAX_JUDGMENTS,
      ...options,
    };
  }

  /**
   * The options this instance actually runs on. `mode` is the kill switch and reaches the stage
   * only through construction, so without a reader for it a build that dropped the wiring goes
   * on auto-merging under a deployment that set `propose`, with the constructor default
   * answering for the config.
   */
  describe(): EntityDedupStageOptions {
    return this.#options;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const mentioned = await findEpisodeEntities(ctx.driver, ctx.episodeId, ctx.now);
    if (mentioned.length === 0) {
      return {
        status: 'skipped',
        summary: 'episode mentions no entities to deduplicate',
        retryable: true,
        settledOnUpstream: {
          disposition: 'not_applicable',
          reason: 'proved_empty_input',
          proof: { mentionedEntities: 0 },
        },
      };
    }

    const subjectIds = [...new Set(mentioned.map((entity) => entity.id))];
    const cache = new EntityDetailCache(ctx.driver);
    await cache.require(subjectIds);

    const owed: WithheldWork[] = [];
    const tier0 = await this.#runTier0(ctx, cache, subjectIds);
    const judged = await this.#runJudgedTiers(ctx, cache, subjectIds, owed);
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
        // Named at zero so a reader can tell a run that withheld nothing from a build that does
        // not measure it.
        merge_withheld: tally.withheld,
        // Blocked work is owed and undecidable until its source returns. Naming it apart is what
        // keeps a run from reading as if it had finished it.
        merge_blocked: tally.blocked,
      },
      // A pair nobody could ask about is still owed, so the stage's key stays open for the run
      // that can decide it, and what it is owed travels with the result rather than as a number.
      ...(tally.withheld > 0 ? { retryable: true } : {}),
      ...(owed.length === 0 ? {} : { withheldWork: owed }),
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
    owed: WithheldWork[],
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
      if (outcome.work !== undefined) {
        owed.push(outcome.work);
      }
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

    const options = {
      model: this.#options.model,
      timeoutMs: this.#options.timeoutMs,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    };
    // Whether this pair's evidence supports asking at all, read before the pair is counted as
    // judged and before either pass runs, so a withheld pair costs nothing and stays exactly as
    // nominated. The episode being reflected on is read first, since it put the pair forward.
    const bare = buildJudgePair(left, right, pair);
    const evidence = await judgmentEvidenceFor(
      ctx.evidence,
      entityJudgmentPair({
        route: 'entity_merge',
        routeReserve: ENTITY_MERGE_ROUTE_RESERVE,
        pair: bare,
        nodeIds: [left.id, right.id],
        promptingSourceId: ctx.episodeId,
      }),
    );
    if (evidence.status === 'withheld') {
      ctx.logger.info(
        {
          leftId: left.id,
          rightId: right.id,
          disposition: evidence.withheld.kind,
          reason: evidence.withheld.reason,
          addresses: evidence.withheld.addresses,
        },
        'entity merge judgment withheld for want of required evidence',
      );
      return {
        tally: {
          ...NOTHING_DONE,
          withheld: 1,
          blocked: evidence.withheld.kind === 'blocked' ? 1 : 0,
        },
        work: withheldWorkFor([left.id, right.id], evidence.withheld),
      };
    }

    const prompt = withEvidence(bare, evidence);
    const asked: CascadeTally = { ...NOTHING_DONE, judged: 1 };

    const detect = await judgeEntityMerge(ctx.provider, prompt, options);
    if (detect.status === 'over-allowance') {
      return this.#overAllowance(ctx, [left.id, right.id], evidence, detect.units);
    }
    if (detect.status === 'failed') {
      ctx.logger.warn(
        { leftId: left.id, rightId: right.id, detail: detect.detail },
        'entity merge judge did not answer',
      );
      return { tally: asked };
    }
    // A refusal settles the pair as much as a merge does, so it is fenced the same way.
    if (!detect.judgment.same) {
      return this.#withheldIfMoved(ctx, [left.id, right.id], evidence, asked) ?? { tally: asked };
    }

    const review = await reviewEntityMerge(ctx.provider, prompt, options);
    if (review.status === 'over-allowance') {
      return this.#overAllowance(ctx, [left.id, right.id], evidence, review.units);
    }
    // An unanswered second pass is a split, not a pass: a merge the substrate cannot defend is
    // a merge it does not make, and the pair goes to the residue lane rather than through.
    // The kill switch stops the write and nothing else. Both passes still run, so a deployment
    // holding the tier back keeps the queue it would have merged and the reasons behind it.
    if (review.status === 'failed' || !review.review.same || this.#options.mode === 'propose') {
      const withheld = this.#withheldIfMoved(ctx, [left.id, right.id], evidence, asked);
      if (withheld !== undefined) {
        return withheld;
      }
      this.#recordProposal(ctx, left, right, pair);
      return { tally: addTallies(asked, { ...NOTHING_DONE, proposals: 1 }) };
    }

    const merging = this.#withheldIfMoved(ctx, [left.id, right.id], evidence, asked);
    if (merging !== undefined) {
      return merging;
    }

    const merged = await this.#mergeJudged(ctx, cache, left, right, pair, {
      detect: detect.judgment,
      review: review.review,
    });
    return {
      tally: addTallies(asked, merged ? { ...NOTHING_DONE, merges: 1, groups: 1 } : NOTHING_DONE),
    };
  }

  /**
   * The pair whose own rendered messages exceed what the route may spend. Nothing was asked and
   * nothing decided, so this is required evidence the substrate could not submit rather than a
   * judgment: it counts as withheld work carrying the pair and its reading, never as a judged
   * pair or a filed proposal.
   */
  #overAllowance(
    ctx: StageContext,
    ids: readonly [string, string],
    evidence: JudgmentEvidenceOutcome,
    units: number,
  ): PairOutcome {
    ctx.logger.info(
      { leftId: ids[0], rightId: ids[1], units },
      'entity merge withheld because its rendered input exceeds the route allowance',
    );
    const revision = evidence.status === 'ready' ? evidence.revision : undefined;
    const tally: CascadeTally = { ...NOTHING_DONE, withheld: 1 };
    if (revision === undefined) {
      return { tally };
    }
    return {
      tally,
      work: withheldWorkFor(ids, {
        kind: 'retryable',
        reason: ENTITY_MERGE_OVER_ALLOWANCE,
        addresses: ids.map((id) => idAddress(id)),
        revision,
      }),
    };
  }

  /**
   * A decision this pair's evidence no longer supports. The provider was asked, so the pair is
   * counted as judged; what it decided is not recorded, and the pair stays owed with the reading
   * it was decided on.
   */
  #withheldIfMoved(
    ctx: StageContext,
    ids: readonly [string, string],
    evidence: JudgmentEvidenceOutcome,
    asked: CascadeTally,
  ): PairOutcome | undefined {
    const moved = evidenceMoved(ctx, evidence);
    if (moved === undefined) {
      return undefined;
    }
    ctx.logger.info(
      { leftId: ids[0], rightId: ids[1], moved },
      'entity merge dropped because its evidence moved while it was judged',
    );
    const work = movedWork(ids, evidence.status === 'ready' ? evidence.revision : undefined, moved);
    return {
      tally: addTallies(asked, { ...NOTHING_DONE, withheld: 1 }),
      ...(work === undefined ? {} : { work }),
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
   * The residue lane. A pair the two passes split on is filed for `proposal_resolution` to decide
   * again on wider evidence, and it is the only thing that writes here now: the cross-type queue
   * this used to fill was an artifact of an identity key that no longer exists.
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
