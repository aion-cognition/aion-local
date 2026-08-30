import { z } from 'zod';

import { RunTally } from './supersession-tally.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { describeError, isAbortError } from '../../../infrastructure/errors.js';
import { supersede } from '../../../infrastructure/graph/bitemporal.js';
import {
  findContradictionCandidates,
  findEpisodeFactNodes,
  findSubjectIdentityCandidates,
  SUPERSESSION_METHOD,
  type ContradictionCandidate,
  type EpisodeFactNode,
} from '../../../infrastructure/graph/supersession-queries.js';
import type {
  ChatMessage,
  JsonSchema,
  Provider,
  Vector,
} from '../../../infrastructure/providers/types.js';
import { recordSupersessionProposal } from '../../../infrastructure/sqlite/supersession-proposals.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * The detection half of supersession. Each fact-bearing node this episode minted is compared against
 * the current claims that name the same subject, and one structured-output judgment per pair
 * decides whether the new statement reverses the old one.
 *
 * Detection is not application. In the default `propose` mode every affirmative judgment
 * becomes a `supersession_proposals` row and nothing touches the graph: measured over a
 * hundred enrichments the judge fired three times, emitted confidence 1.0 each time, and was
 * wrong all three, so a confidence gate gated nothing. `auto` restores the split for the day
 * a quality harness measures precision on the contradiction battery.
 *
 * Entities are deliberately out of scope: extraction merges them on `(name_norm, type)`, so a
 * second episode naming the same entity reuses the same node and there is no new node to
 * supersede it with. Near-duplicate identities are the dedup stage's job.
 */

export const SUPERSESSION_STAGE_NAME = 'supersession';

export type SupersessionMode = 'propose' | 'auto';

/** The pinned `AION_SUPERSEDE_MODE`. Propose-only until precision is measured, not assumed. */
export const DEFAULT_SUPERSEDE_MODE: SupersessionMode = DEFAULTS.reflection.supersedeMode;

/** The pinned `AION_SUPERSEDE_AUTO_CONFIDENCE`: the `auto` mode's threshold, read nowhere else. */
export const DEFAULT_SUPERSEDE_AUTO_CONFIDENCE = DEFAULTS.reflection.supersedeAutoConfidence;

/** Applied only when the model omits the optional field: an unstated confidence never auto-applies. */
const UNSTATED_CONFIDENCE = 0.5;

export type SupersessionStageOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly mode: SupersessionMode;
  readonly autoConfidence: number;
  readonly neighborThreshold: number;
  readonly maxSubjects: number;
  readonly maxNeighbors: number;
  readonly maxJudgments: number;
};

const JUDGMENT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    contradicts: { type: 'boolean' },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['contradicts', 'confidence'],
};

/** Looser than the JSON schema on purpose: a judgment missing its rationale is still usable. */
const JudgmentSchema = z.object({
  contradicts: z.boolean(),
  confidence: z.number().optional(),
  rationale: z.string().optional(),
});

/**
 * The four discriminations the measured false positives turned on. Each rule names a shape
 * the judge answered "contradicts" to at confidence 1.0 while both statements stayed true.
 */
const SYSTEM_PROMPT = [
  'You judge whether a new statement contradicts an earlier one from the same memory substrate.',
  'They contradict only when both cannot hold at once: the new statement reverses, replaces, or',
  'corrects the earlier one about the same subject.',
  'Answer false when the two statements are about different subjects, even when they share',
  'wording or shape: two services, components, environments, or people with similar policies',
  'are separate facts, and both stay true.',
  'Answer false when the new statement restates, summarises, or rephrases the earlier one,',
  'including when one is vaguer or more precise than the other. A restatement replaces nothing.',
  'Answer false when the two describe different times and neither claims to be the current',
  'state: a record of what happened once does not contradict a later state or a standing rule,',
  'and a past observation stays true after the thing it observed changes.',
  'Answer false when the statements record two people disagreeing. A stated position is not',
  'made untrue by a colleague holding another one.',
  'Answer with contradicts, a confidence between 0 and 1 for how sure the pair makes you, and a',
  'one-clause rationale naming the subject both statements are about. Say false rather than guess.',
].join(' ');

function buildMessages(
  priorKind: string,
  currentKind: string,
  prior: string,
  current: string,
  sharedSubject: string | undefined,
): ChatMessage[] {
  const subjectLine =
    sharedSubject === undefined ? '' : `\n\nBoth statements name: ${sharedSubject}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Earlier statement (kind ${priorKind}):\n${prior}\n\n` +
        `New statement (kind ${currentKind}):\n${current}${subjectLine}`,
    },
  ];
}

function clampConfidence(value: number | undefined): number {
  const raw = value ?? UNSTATED_CONFIDENCE;
  if (!Number.isFinite(raw)) {
    return UNSTATED_CONFIDENCE;
  }
  return Math.min(1, Math.max(0, raw));
}

export type ContradictionJudgment = {
  readonly contradicts: boolean;
  readonly confidence: number;
  readonly rationale?: string;
};

/** Two statements and, when the shared-subject leg found one, the subject they both name. */
export type ContradictionPair = {
  readonly priorLabel: string;
  readonly currentLabel: string;
  readonly prior: string;
  readonly current: string;
  readonly sharedSubject?: string;
};

export type JudgeContradictionOptions = {
  readonly model: string;
  readonly timeoutMs: number;
};

/**
 * `failed` is a call that threw or timed out; `unusable` is an answer that came back in a
 * shape the schema refuses. The stage logs the two differently and a precision battery
 * scores neither, so the caller needs them apart rather than folded into one `undefined`.
 */
export type JudgeOutcome =
  | { readonly status: 'judged'; readonly judgment: ContradictionJudgment }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'unusable' };

/**
 * One judgment, prompt and schema included. Exported because precision is measured on this
 * call rather than on the stage around it: a battery that rebuilt the prompt would report a
 * number for a judge the service does not run.
 */
export async function judgeContradiction(
  provider: Pick<Provider, 'generate'>,
  pair: ContradictionPair,
  options: JudgeContradictionOptions,
): Promise<JudgeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildMessages(
        pair.priorLabel,
        pair.currentLabel,
        pair.prior,
        pair.current,
        pair.sharedSubject,
      ),
      schema: JUDGMENT_JSON_SCHEMA,
      // Reasoning buys nothing on a two-statement judgment and costs the budget (mirrors
      // the extraction stages).
      think: false,
      signal: controller.signal,
    });
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    clearTimeout(timer);
  }

  const parsed = JudgmentSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'unusable' };
  }

  const rationale = parsed.data.rationale?.trim();
  return {
    status: 'judged',
    judgment: {
      contradicts: parsed.data.contradicts,
      confidence: clampConfidence(parsed.data.confidence),
      ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
    },
  };
}

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
      ...options,
    };
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const facts = await findEpisodeFactNodes(ctx.driver, ctx.episodeId);
    if (facts.length === 0) {
      return { status: 'skipped', summary: 'episode has no fact-bearing nodes to check' };
    }

    const siblingIds = facts.map((fact) => fact.id);
    const subjects = facts
      .filter(
        (fact): fact is FactSubject =>
          fact.contentVector !== undefined && fact.text.trim().length > 0,
      )
      .slice(0, this.#options.maxSubjects);
    if (subjects.length === 0) {
      return { status: 'skipped', summary: 'fact nodes carry no content vectors yet' };
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
   * Subject identity first, embedding proximity only to fill the remaining slots. Both sides
   * of a real reversal name the same subject, and the KNN leg alone both missed those pairs
   * and supplied every measured false positive.
   */
  async #findCandidates(
    ctx: StageContext,
    subject: FactSubject,
    siblingIds: readonly string[],
  ): Promise<ContradictionCandidate[]> {
    const bySubject = await findSubjectIdentityCandidates(ctx.driver, {
      episodeId: ctx.episodeId,
      subjectTextNorm: subject.textNorm,
      vector: subject.contentVector,
      excludeIds: siblingIds,
      limit: this.#options.maxNeighbors,
    });
    if (bySubject.length >= this.#options.maxNeighbors) {
      return bySubject;
    }

    const seen = new Set(bySubject.map((candidate) => candidate.id));
    const byVector = await findContradictionCandidates(ctx.driver, {
      vector: subject.contentVector,
      excludeIds: [...siblingIds, ...seen],
      threshold: this.#options.neighborThreshold,
      limit: this.#options.maxNeighbors - bySubject.length,
    });
    return [...bySubject, ...byVector];
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

      const judgment = await this.#judge(ctx, subject, candidate, tally);
      if (!judgment?.contradicts) {
        continue;
      }

      try {
        await this.#apply(ctx, subject, candidate, judgment, tally);
      } catch (error) {
        return error;
      }
    }
    return undefined;
  }

  /** A judgment that fails is counted and skipped: one unusable answer does not fail the stage. */
  async #judge(
    ctx: StageContext,
    subject: EpisodeFactNode,
    candidate: ContradictionCandidate,
    tally: RunTally,
  ): Promise<ContradictionJudgment | undefined> {
    tally.recordJudgment();
    const outcome = await judgeContradiction(
      ctx.provider,
      {
        priorLabel: candidate.label,
        currentLabel: subject.label,
        prior: candidate.text,
        current: subject.text,
        ...(candidate.sharedSubject === undefined
          ? {}
          : { sharedSubject: candidate.sharedSubject }),
      },
      { model: this.#options.model, timeoutMs: this.#options.timeoutMs },
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

  /**
   * In `propose` mode the graph is never touched, so a re-run re-judges the same pair and
   * refreshes the one proposal row rather than adding a second. In `auto` mode `supersede()`
   * owns its own transaction and is a no-op on repeat, and the closed node drops out of the
   * next run's candidate search.
   */
  async #apply(
    ctx: StageContext,
    subject: EpisodeFactNode,
    candidate: ContradictionCandidate,
    judgment: ContradictionJudgment,
    tally: RunTally,
  ): Promise<void> {
    if (this.#options.mode === 'auto' && judgment.confidence >= this.#options.autoConfidence) {
      await supersede(ctx.driver, {
        oldId: candidate.id,
        newId: subject.id,
        now: ctx.now,
        signals: ['contradiction'],
        provenance: [SUPERSESSION_METHOD],
      });
      tally.recordSupersession();
      return;
    }

    recordSupersessionProposal(ctx.db, {
      oldId: candidate.id,
      newId: subject.id,
      confidence: judgment.confidence,
      episodeId: ctx.episodeId,
      createdAt: ctx.now.toISOString(),
      ...(judgment.rationale === undefined ? {} : { rationale: judgment.rationale }),
    });
    tally.recordProposal(candidate.matchedBy === 'subject');
  }

  #report(tally: RunTally, writeError: unknown): StageOutcome {
    const counts = {
      supersessions: tally.superseded,
      supersessionProposals: tally.proposed,
    };

    if (writeError !== undefined) {
      return {
        status: 'failed',
        summary: `supersession recorded ${tally.superseded} closure(s) before a write failed: ${describeError(writeError)}`,
        counts,
      };
    }

    if (tally.judgeErrors > 0 && tally.judgeErrors === tally.judgments) {
      return {
        status: 'failed',
        summary: `all ${tally.judgments} contradiction judgment(s) failed`,
        counts,
      };
    }

    return {
      status: 'ok',
      summary:
        `${tally.judgments} contradiction judgment(s) in ${this.#options.mode} mode: ` +
        `${tally.superseded} superseded, ${tally.proposed} proposed for review ` +
        `(${tally.proposedBySubject} by shared subject)`,
      counts,
    };
  }
}
