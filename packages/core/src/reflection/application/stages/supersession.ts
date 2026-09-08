import { applyJudgment, type SupersessionMode } from './supersession-apply.js';
import {
  judgeContradiction,
  LIVE_SUPERSESSION_ROUTE_RESERVE,
  type ContradictionJudgment,
  type ContradictionPair,
  type JudgeContradictionOptions,
  type JudgeOutcome,
} from './supersession-judge.js';
import { RunTally } from './supersession-tally.js';
import {
  judgmentEvidenceFor,
  statementWithContext,
  withheldWorkFor,
  type JudgmentEvidenceOutcome,
} from '../../../evidence/application/judgment.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { describeError, isAbortError } from '../../../infrastructure/errors.js';
import type { KeyedCloseMode } from '../../../infrastructure/graph/claim-key-queries.js';
import {
  findContradictionCandidates,
  findEpisodeFactNodes,
  findKeyedCandidates,
  findSubjectIdentityCandidates,
  type ContradictionCandidate,
  type EpisodeFactNode,
} from '../../../infrastructure/graph/supersession-queries.js';
import type { Vector } from '../../../infrastructure/providers/types.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * The detection half of supersession. Each fact-bearing node this episode minted is compared against
 * the current claims that name the same subject, and one structured-output judgment per pair
 * decides whether the new statement reverses the old one.
 *
 * Detection is not application, and confidence is not the gate. Measured over a hundred
 * enrichments the local judge fired three times, emitted confidence 1.0 each time, and was
 * wrong all three; the remote judge answers 0.95 to every affirmative. A number that never
 * varies cannot separate a right answer from a wrong one, so what gates a close here is a
 * second opinion rather than a threshold: `unanimous` mode sends every affirmative to
 * `supersession-review.ts`, which argues the other side on the same evidence, and closes only
 * what both passes agree on. `propose` writes every affirmative to `supersession_proposals`
 * and touches nothing, which makes it the kill switch. `auto` is the confidence-gated
 * predecessor, kept valid for a deployment that pinned it.
 *
 * A claim that carries a subject key reaches the same judge through a leg of its own. Under
 * `AION_KEYED_CLOSE_MODE=judge` the key generates the candidate and the two passes still decide
 * it, so the key buys precision on what gets asked about and changes nothing about who answers.
 *
 * Entities are deliberately out of scope: extraction merges them on `name_norm`, so a
 * second episode naming the same entity reuses the same node and there is no new node to
 * supersede it with. Near-duplicate identities are the dedup stage's job.
 */

export const SUPERSESSION_STAGE_NAME = 'supersession';

export type { SupersessionMode };

// The judge is re-exported here because this is the door the barrel and the batteries already
// use; it lives beside the stage rather than inside it.
export {
  judgeContradiction,
  type ContradictionJudgment,
  type ContradictionPair,
  type JudgeContradictionOptions,
  type JudgeOutcome,
};

/** The pinned `AION_SUPERSEDE_MODE`, set by the battery's measurement rather than by hand. */
export const DEFAULT_SUPERSEDE_MODE: SupersessionMode = DEFAULTS.reflection.supersedeMode;

/** The pinned `AION_SUPERSEDE_AUTO_CONFIDENCE`: the `auto` mode's threshold, read nowhere else. */
export const DEFAULT_SUPERSEDE_AUTO_CONFIDENCE = DEFAULTS.reflection.supersedeAutoConfidence;

export type SupersessionStageOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly mode: SupersessionMode;
  readonly autoConfidence: number;
  readonly neighborThreshold: number;
  readonly maxSubjects: number;
  readonly maxNeighbors: number;
  readonly maxJudgments: number;
  /** How wide a unanimous close cuts: the same family floor `aion proposals apply` runs on. */
  readonly familyRelatednessFloor: number;
  /** Where a keyed pair goes: `judge` puts it in front of this stage, and no other value does. */
  readonly keyedCloseMode: KeyedCloseMode;
};

/** A fact node that can actually search: text to judge and a vector to search with. */
type FactSubject = EpisodeFactNode & { readonly contentVector: Vector };

export class SupersessionStage implements ReflectionStage {
  readonly name = SUPERSESSION_STAGE_NAME;
  readonly #options: SupersessionStageOptions;

  constructor(options: Partial<SupersessionStageOptions> = {}) {
    this.#options = {
      model: DEFAULTS.models.reflect,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      mode: DEFAULTS.reflection.supersedeMode,
      autoConfidence: DEFAULTS.reflection.supersedeAutoConfidence,
      neighborThreshold: DEFAULTS.reflection.supersedeNeighborThreshold,
      maxSubjects: DEFAULTS.reflection.maxSupersessionSubjects,
      maxNeighbors: DEFAULTS.reflection.maxContradictionNeighbors,
      maxJudgments: DEFAULTS.reflection.maxContradictionJudgments,
      familyRelatednessFloor: DEFAULTS.reflection.supersedeFamilyRelatednessFloor,
      keyedCloseMode: DEFAULTS.reflection.keyedCloseMode,
      ...options,
    };
  }

  /**
   * The options this instance actually runs on. `mode` is the kill switch and reaches the stage
   * only through construction, so without a reader for it a build that dropped the wiring goes
   * on closing claims under a deployment that set `propose`.
   */
  describe(): SupersessionStageOptions {
    return this.#options;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const facts = await findEpisodeFactNodes(ctx.driver, ctx.episodeId, ctx.now);
    if (facts.length === 0) {
      return {
        status: 'skipped',
        summary: 'episode has no fact-bearing nodes to check',
        retryable: true,
      };
    }

    const siblingIds = facts.map((fact) => fact.id);
    const subjects = facts
      .filter(
        (fact): fact is FactSubject =>
          fact.contentVector !== undefined && fact.text.trim().length > 0,
      )
      .slice(0, this.#options.maxSubjects);
    if (subjects.length === 0) {
      return {
        status: 'skipped',
        summary: 'fact nodes carry no content vectors yet',
        retryable: true,
      };
    }

    const tally = new RunTally();
    let writeError: unknown;

    for (const subject of subjects) {
      if (tally.judgments >= this.#options.maxJudgments) {
        break;
      }
      const outcome = await this.#checkSubject(ctx, subject, siblingIds, tally);
      if (outcome !== undefined) {
        writeError = outcome;
        break;
      }
    }

    return this.#report(tally, writeError);
  }

  /**
   * The key first, then subject identity, then embedding proximity for what is left. Both sides
   * of a real reversal name the same subject, and the KNN leg alone both missed those pairs and
   * supplied every measured false positive; a key states that without a substring test.
   */
  async #findCandidates(
    ctx: StageContext,
    subject: FactSubject,
    siblingIds: readonly string[],
  ): Promise<ContradictionCandidate[]> {
    const { maxNeighbors } = this.#options;
    const byKey = await this.#keyedCandidates(ctx, subject, siblingIds);
    if (byKey.length >= maxNeighbors) {
      return byKey;
    }

    const seen = new Set(byKey.map((candidate) => candidate.id));
    const bySubject = await findSubjectIdentityCandidates(ctx.driver, {
      episodeId: ctx.episodeId,
      subjectTextNorm: subject.textNorm,
      vector: subject.contentVector,
      excludeIds: [...siblingIds, ...seen],
      limit: maxNeighbors - byKey.length,
    });
    const found = [...byKey, ...bySubject];
    if (found.length >= maxNeighbors) {
      return found;
    }
    const byVector = await findContradictionCandidates(ctx.driver, {
      vector: subject.contentVector,
      excludeIds: [...siblingIds, ...found.map((candidate) => candidate.id)],
      threshold: this.#options.neighborThreshold,
      limit: maxNeighbors - found.length,
    });
    return [...found, ...byVector];
  }

  /**
   * The keyed leg runs in `judge` mode alone: in `close` mode the write already took the
   * key-mate in its own transaction, and in `off` mode the claim stored no key. A key that
   * matched nothing filters out nothing, and the claim falls through to the two legs below.
   */
  async #keyedCandidates(
    ctx: StageContext,
    subject: FactSubject,
    siblingIds: readonly string[],
  ): Promise<ContradictionCandidate[]> {
    const { subjectEntityId, aspectNorm } = subject;
    if (
      this.#options.keyedCloseMode !== 'judge' ||
      subjectEntityId === undefined ||
      aspectNorm === undefined
    ) {
      return [];
    }
    return findKeyedCandidates(ctx.driver, {
      subjectEntityId,
      aspectNorm,
      vector: subject.contentVector,
      excludeIds: siblingIds,
      limit: this.#options.maxNeighbors,
    });
  }

  /** Returns the write error that stopped the run, or undefined when the subject was fully checked. */
  async #checkSubject(
    ctx: StageContext,
    subject: FactSubject,
    siblingIds: readonly string[],
    tally: RunTally,
  ): Promise<unknown> {
    const candidates = await this.#findCandidates(ctx, subject, siblingIds);

    for (const candidate of candidates) {
      if (tally.judgments >= this.#options.maxJudgments) {
        return undefined;
      }

      const evidence = await this.#evidenceFor(ctx, subject, candidate);
      if (evidence.status === 'withheld') {
        tally.recordWithheld(
          evidence.withheld.kind,
          withheldWorkFor([candidate.id, subject.id], evidence.withheld),
        );
        ctx.logger.info(
          {
            episodeId: ctx.episodeId,
            subjectId: subject.id,
            candidateId: candidate.id,
            disposition: evidence.withheld.kind,
            reason: evidence.withheld.reason,
            addresses: evidence.withheld.addresses,
            revision: evidence.withheld.revision.digest,
          },
          'contradiction judgment withheld for want of required evidence',
        );
        continue;
      }
      const judgment = await this.#judge(ctx, subject, candidate, tally, evidence);
      if (!judgment?.contradicts) {
        continue;
      }

      try {
        await this.#apply(ctx, subject, candidate, judgment, tally, evidence);
      } catch (error) {
        return error;
      }
    }
    return undefined;
  }

  /** The evidence this pair may be judged on, asked once and used by both passes. */
  async #evidenceFor(
    ctx: StageContext,
    subject: EpisodeFactNode,
    candidate: ContradictionCandidate,
  ): Promise<JudgmentEvidenceOutcome> {
    return judgmentEvidenceFor(ctx.evidence, {
      route: 'live_supersession',
      reservedUnits: LIVE_SUPERSESSION_ROUTE_RESERVE,
      use: 'claim_judgment',
      sides: [
        { nodeId: candidate.id, statement: candidate.text },
        { nodeId: subject.id, statement: subject.text },
      ],
    });
  }

  /** A judgment that fails is counted and skipped: one unusable answer does not fail the stage. */
  async #judge(
    ctx: StageContext,
    subject: EpisodeFactNode,
    candidate: ContradictionCandidate,
    tally: RunTally,
    evidence: JudgmentEvidenceOutcome,
  ): Promise<ContradictionJudgment | undefined> {
    const sides = evidence.status === 'ready' ? evidence.sides : undefined;
    tally.recordJudgment();
    const outcome = await judgeContradiction(
      ctx.provider,
      {
        priorLabel: candidate.label,
        currentLabel: subject.label,
        prior: statementWithContext(candidate.text, sides?.[0]),
        current: statementWithContext(subject.text, sides?.[1]),
        ...(candidate.sharedSubject === undefined
          ? {}
          : { sharedSubject: candidate.sharedSubject }),
      },
      {
        model: this.#options.model,
        timeoutMs: this.#options.timeoutMs,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );

    if (outcome.status === 'judged') {
      return outcome.judgment;
    }

    tally.recordJudgeError();
    const where = { episodeId: ctx.episodeId, subjectId: subject.id, candidateId: candidate.id };
    if (outcome.status === 'failed') {
      ctx.logger.warn(
        { err: outcome.error, ...where },
        `contradiction judgment ${isAbortError(outcome.error) ? 'timed out' : 'failed'}`,
      );
      return undefined;
    }
    ctx.logger.warn(where, 'contradiction judgment returned an invalid shape');
    return undefined;
  }

  /** What an affirmative judgment does per mode, including the second pass `unanimous` gates on. */
  async #apply(
    ctx: StageContext,
    subject: EpisodeFactNode,
    candidate: ContradictionCandidate,
    judgment: ContradictionJudgment,
    tally: RunTally,
    evidence: JudgmentEvidenceOutcome,
  ): Promise<void> {
    const sides = evidence.status === 'ready' ? evidence.sides : undefined;
    const outcome = await applyJudgment(
      ctx,
      {
        subject,
        candidate,
        confidence: judgment.confidence,
        ...(judgment.rationale === undefined ? {} : { rationale: judgment.rationale }),
        // The second pass argues the other side of what the first pass was shown, and the write
        // is fenced on the same revision both of them ran on.
        ...(sides === undefined
          ? {}
          : {
              context: {
                prior: statementWithContext(candidate.text, sides[0]),
                current: statementWithContext(subject.text, sides[1]),
              },
            }),
        ...(evidence.status === 'ready' ? { revision: evidence.revision } : {}),
      },
      // The stage options carry the write policy whole; the judge's search knobs ride along.
      this.#options,
      tally,
    );
    ctx.logger.debug(
      {
        episodeId: ctx.episodeId,
        subjectId: subject.id,
        candidateId: candidate.id,
        outcome,
      },
      `contradiction judgment ${outcome}`,
    );
  }

  #report(tally: RunTally, writeError: unknown): StageOutcome {
    const counts = {
      supersessions: tally.superseded,
      supersessionProposals: tally.proposed,
      // Named even at zero, so a reader of one run's counts can tell "none went stale" from
      // "this build does not measure that".
      supersessionStaleTargets: tally.staleTargets,
      // Named at zero for the same reason the stale count is: a reader can tell "none withheld"
      // from a build that does not measure it.
      supersessionWithheld: tally.withheld,
      // Blocked work is owed and undecidable until its source returns; retryable work is owed and
      // decidable once a backfill or a settled publication lands. Naming them apart is what keeps
      // a run from reading as if it had finished either one.
      supersessionBlocked: tally.blocked,
    };

    if (writeError !== undefined) {
      return {
        status: 'failed',
        summary: `supersession recorded ${tally.superseded} closure(s) before a write failed: ${describeError(writeError)}`,
        counts,
      };
    }

    if (tally.judgments === 0 && tally.withheld > 0) {
      return {
        status: 'skipped',
        summary: `${tally.withheld} pair(s) withheld for want of required evidence`,
        counts,
        retryable: true,
        ...(tally.work.length === 0 ? {} : { withheldWork: tally.work }),
      };
    }

    if (tally.judgeErrors > 0 && tally.judgeErrors === tally.judgments) {
      return {
        status: 'failed',
        summary: `all ${tally.judgments} contradiction judgment(s) failed`,
        counts,
      };
    }

    // The second pass runs in `unanimous` mode alone, so its counters are named only there
    // rather than reported as two zeroes on every other run. The stale count is named by both
    // closing modes, since either can find its target already taken.
    const stale =
      this.#options.mode === 'propose'
        ? ''
        : `, ${tally.staleTargets} with the target already gone`;
    const review =
      this.#options.mode === 'unanimous'
        ? `, second pass ${tally.unanimous} unanimous and ${tally.vetoed} vetoed`
        : '';

    return {
      status: 'ok',
      // Work nobody could ask about is still owed. The stage's key stays open so the run that
      // can decide it re-enters the stage, whatever else this run managed to close, and what it
      // is owed travels with the result rather than as a number.
      ...(tally.withheld > 0 ? { retryable: true } : {}),
      ...(tally.work.length === 0 ? {} : { withheldWork: tally.work }),
      summary:
        `${tally.judgments} contradiction judgment(s) in ${this.#options.mode} mode: ` +
        `${tally.superseded} superseded, ${tally.proposed} proposed for review ` +
        `(${tally.proposedBySubject} by shared subject)` +
        `${tally.withheld === 0 ? '' : `, ${tally.withheld} withheld`}${review}${stale}`,
      counts,
    };
  }
}
