import { z } from 'zod';
import { supersede } from '../../../infrastructure/graph/bitemporal.js';
import {
  findContradictionCandidates,
  findEpisodeFactNodes,
  SUPERSESSION_METHOD,
  type ContradictionCandidate,
  type EpisodeFactNode,
} from '../../../infrastructure/graph/supersession-queries.js';
import type { ChatMessage, JsonSchema, Vector } from '../../../infrastructure/providers/types.js';
import { recordSupersessionProposal } from '../../../infrastructure/sqlite/supersession-proposals.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * PRD §5.5's detection half. Each fact-bearing node this episode minted is compared against
 * the current nodes of its own kind that sit closest to it in embedding space, and one
 * structured-output judgment per close pair decides whether the new statement reverses the
 * old one. A confident yes closes the old node through `supersede()`; anything less is a
 * proposal row a person resolves later. Nothing here deletes, and nothing sub-threshold
 * touches the graph.
 *
 * Entities are deliberately out of scope: extraction merges them on `(name_norm, type)`, so a
 * second episode naming the same entity reuses the same node and there is no new node to
 * supersede it with. Near-duplicate identities are the dedup stage's job.
 */

export const SUPERSESSION_STAGE_NAME = 'supersession';

/** `config.models.reflect`'s pinned default; the Integration task threads the configured value in. */
export const DEFAULT_SUPERSESSION_MODEL = 'qwen3:8b';

/** Per judgment, not per run: qwen3:8b with thinking off still owes a guard on every call. */
export const DEFAULT_SUPERSESSION_TIMEOUT_MS = 60_000;

/** The pinned `AION_SUPERSEDE_AUTO_CONFIDENCE`. At or above it the supersession applies itself. */
export const DEFAULT_SUPERSEDE_AUTO_CONFIDENCE = 0.85;

/**
 * How close two claims must sit before a judgment is worth spending. Same family as
 * `AION_ASSOC_SEMANTIC_THRESHOLD`: statements that reverse each other restate the same
 * subject, so they land near each other even as they disagree.
 */
export const DEFAULT_CONTRADICTION_NEIGHBOR_THRESHOLD = 0.75;

/**
 * The run's bound on model calls. Subjects and neighbours cap the fan-out; `maxJudgments`
 * caps the product, so one episode costs at most eight generate calls however many facts it
 * carried. At the measured think-false latency that keeps the stage inside roughly a minute,
 * matching every other stage's single-call budget.
 */
export const DEFAULT_MAX_SUPERSESSION_SUBJECTS = 6;
export const DEFAULT_MAX_CONTRADICTION_NEIGHBORS = 3;
export const DEFAULT_MAX_CONTRADICTION_JUDGMENTS = 8;

/** Applied only when the model omits the optional field: an unstated confidence never auto-applies. */
const UNSTATED_CONFIDENCE = 0.5;

export type SupersessionStageOptions = {
  readonly model: string;
  readonly timeoutMs: number;
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

const SYSTEM_PROMPT = [
  'You judge whether a new statement contradicts an earlier one from the same memory substrate.',
  'They contradict when both cannot hold at once: the new statement reverses, replaces, or',
  'corrects the earlier one about the same subject. Statements that merely relate to each other,',
  'that repeat the same claim, or that speak about different subjects do not contradict.',
  'Answer with contradicts, a confidence between 0 and 1 for how sure the pair makes you, and a',
  'one-clause rationale. Say false rather than guess.',
].join(' ');

function buildMessages(kind: string, prior: string, current: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Both statements are of kind ${kind}.\n\nEarlier statement:\n${prior}\n\nNew statement:\n${current}`,
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

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** A fact node that can actually search: text to judge and a vector to search with. */
type FactSubject = EpisodeFactNode & { readonly contentVector: Vector };

type Judgment = {
  readonly contradicts: boolean;
  readonly confidence: number;
  readonly rationale?: string;
};

type RunTally = {
  superseded: number;
  proposed: number;
  judgments: number;
  judgeErrors: number;
};

export class SupersessionStage implements ReflectionStage {
  readonly name = SUPERSESSION_STAGE_NAME;
  readonly #options: SupersessionStageOptions;

  constructor(options: Partial<SupersessionStageOptions> = {}) {
    this.#options = {
      model: DEFAULT_SUPERSESSION_MODEL,
      timeoutMs: DEFAULT_SUPERSESSION_TIMEOUT_MS,
      autoConfidence: DEFAULT_SUPERSEDE_AUTO_CONFIDENCE,
      neighborThreshold: DEFAULT_CONTRADICTION_NEIGHBOR_THRESHOLD,
      maxSubjects: DEFAULT_MAX_SUPERSESSION_SUBJECTS,
      maxNeighbors: DEFAULT_MAX_CONTRADICTION_NEIGHBORS,
      maxJudgments: DEFAULT_MAX_CONTRADICTION_JUDGMENTS,
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

    const tally: RunTally = { superseded: 0, proposed: 0, judgments: 0, judgeErrors: 0 };
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

  /** Returns the write error that stopped the run, or undefined when the subject was fully checked. */
  async #checkSubject(
    ctx: StageContext,
    subject: FactSubject,
    siblingIds: readonly string[],
    tally: RunTally,
  ): Promise<unknown> {
    const candidates = await findContradictionCandidates(ctx.driver, {
      label: subject.label,
      vector: subject.contentVector,
      excludeIds: siblingIds,
      threshold: this.#options.neighborThreshold,
      limit: this.#options.maxNeighbors,
    });

    for (const candidate of candidates) {
      if (tally.judgments >= this.#options.maxJudgments) {
        return undefined;
      }

      const judgment = await this.#judge(ctx, subject, candidate, tally);
      if (judgment === undefined || !judgment.contradicts) {
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
  ): Promise<Judgment | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    tally.judgments += 1;
    let raw: unknown;
    try {
      raw = await ctx.provider.generate({
        model: this.#options.model,
        messages: buildMessages(subject.label, candidate.text, subject.text),
        schema: JUDGMENT_JSON_SCHEMA,
        // Reasoning buys nothing on a two-statement judgment and costs the budget (mirrors
        // the extraction stages).
        think: false,
        signal: controller.signal,
      });
    } catch (error) {
      tally.judgeErrors += 1;
      ctx.logger.warn(
        { err: error, episodeId: ctx.episodeId, subjectId: subject.id, candidateId: candidate.id },
        `contradiction judgment ${isAbortError(error) ? 'timed out' : 'failed'}`,
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    const parsed = JudgmentSchema.safeParse(raw);
    if (!parsed.success) {
      tally.judgeErrors += 1;
      ctx.logger.warn(
        { episodeId: ctx.episodeId, subjectId: subject.id, candidateId: candidate.id },
        'contradiction judgment returned an invalid shape',
      );
      return undefined;
    }

    const rationale = parsed.data.rationale?.trim();
    return {
      contradicts: parsed.data.contradicts,
      confidence: clampConfidence(parsed.data.confidence),
      ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
    };
  }

  /**
   * The threshold split. `supersede()` owns its own transaction and is a no-op on repeat, and
   * the closed node drops out of the next run's candidate search, so a re-run neither writes
   * again nor pays for the judgment a second time.
   */
  async #apply(
    ctx: StageContext,
    subject: EpisodeFactNode,
    candidate: ContradictionCandidate,
    judgment: Judgment,
    tally: RunTally,
  ): Promise<void> {
    if (judgment.confidence >= this.#options.autoConfidence) {
      await supersede(ctx.driver, {
        oldId: candidate.id,
        newId: subject.id,
        now: ctx.now,
        signals: ['contradiction'],
        provenance: [SUPERSESSION_METHOD],
      });
      tally.superseded += 1;
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
    tally.proposed += 1;
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
        `${tally.judgments} contradiction judgment(s): ${tally.superseded} superseded, ` +
        `${tally.proposed} proposed for review`,
      counts,
    };
  }
}
