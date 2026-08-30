import {
  describeVeto,
  reviewContradiction,
  vetoForUnansweredReview,
  type ReviewVerdict,
} from './supersession-review.js';
import type { RunTally } from './supersession-tally.js';
import { isAbortError } from '../../../infrastructure/errors.js';
import { supersede } from '../../../infrastructure/graph/bitemporal.js';
import {
  findNodesWithoutCurrency,
  SUPERSESSION_METHOD,
  type ContradictionCandidate,
  type EpisodeFactNode,
} from '../../../infrastructure/graph/supersession-queries.js';
import {
  findSupersessionProposalsForNode,
  recordSupersessionProposal,
  resolveSupersessionProposal,
} from '../../../infrastructure/sqlite/supersession-proposals.js';
import type { StageContext } from '../../domain/stage.js';
import {
  applySupersessionProposal,
  UNANIMOUS_APPLY_METHOD,
  UNANIMOUS_APPLY_SIGNALS,
} from '../proposals.js';

/**
 * What an affirmative judgment does, which is the only thing the three modes disagree about.
 *
 * `propose` records the row and stops, so nothing the judge believes reaches the graph.
 * `unanimous` sends the same pair to the second pass and closes only what both passes affirm,
 * through the apply path `aion proposals apply` runs, so an autonomous close cuts exactly as
 * wide as a reviewed one and carries its own provenance. `auto` is the confidence gate that
 * came before either, kept working for a deployment that pinned it.
 *
 * Every path records the proposal row. A closed claim's row is resolved on the way out, and a
 * vetoed one stays open carrying the veto, so `aion proposals ls` is the record of what the
 * judge wanted and what stopped it either way.
 *
 * What a judgment did is reported three ways rather than two, and read off the graph rather
 * than off which branch ran: see `JudgmentOutcome`.
 */

export type SupersessionMode = 'propose' | 'auto' | 'unanimous';

export type SupersessionWritePolicy = {
  readonly mode: SupersessionMode;
  readonly autoConfidence: number;
  readonly familyRelatednessFloor: number;
  readonly model: string;
  readonly timeoutMs: number;
};

/** An affirmative judgment and its two sides. A negative one never reaches here. */
export type JudgedPair = {
  readonly subject: EpisodeFactNode;
  readonly candidate: ContradictionCandidate;
  readonly confidence: number;
  readonly rationale?: string;
};

/**
 * How a judgment ended, told apart by graph state rather than by which write ran.
 *
 * Three of these are what a count or an agreement rate may be built from: `closed` is a
 * judgment that acted on a live target, `vetoed` and `proposed` are judgments downgraded to
 * review, and `stale` is neither. A stale judgment was made and then had nothing left to take,
 * because a family close earlier in the same run or a person reviewing a neighbouring proposal
 * had already taken the losing side. It is counted apart and scored by nothing: reading it as
 * a closure inflates what the judge did, and reading it as a veto invents a disagreement
 * nobody had.
 *
 * `already_decided` is the fourth and writes no counter at all. The pair carries a person's
 * ruling, so the stage leaves it alone, and there is no new judgment to report.
 */
export type JudgmentOutcome = 'closed' | 'vetoed' | 'stale' | 'proposed' | 'already_decided';

/** Both passes on one line, so `aion proposals ls` says what the judge wanted and what stopped it. */
function rationaleFor(pair: JudgedPair, second: string | undefined): string | undefined {
  const first = pair.rationale?.trim();
  const stated = first === undefined || first.length === 0 ? undefined : first;
  if (second === undefined) {
    return stated;
  }
  return stated === undefined ? second : `${second} (first pass: ${stated})`;
}

function record(ctx: StageContext, pair: JudgedPair, second: string | undefined): string {
  const rationale = rationaleFor(pair, second);
  return recordSupersessionProposal(ctx.db, {
    oldId: pair.candidate.id,
    newId: pair.subject.id,
    confidence: pair.confidence,
    episodeId: ctx.episodeId,
    createdAt: ctx.now.toISOString(),
    ...(rationale === undefined ? {} : { rationale }),
  });
}

/** A review that threw, timed out, or came back unusable vetoes: an undefended close is not made. */
async function secondPass(
  ctx: StageContext,
  pair: JudgedPair,
  policy: SupersessionWritePolicy,
): Promise<ReviewVerdict> {
  const outcome = await reviewContradiction(
    ctx.provider,
    {
      priorLabel: pair.candidate.label,
      currentLabel: pair.subject.label,
      prior: pair.candidate.text,
      current: pair.subject.text,
      ...(pair.candidate.sharedSubject === undefined
        ? {}
        : { sharedSubject: pair.candidate.sharedSubject }),
    },
    { model: policy.model, timeoutMs: policy.timeoutMs },
  );

  if (outcome.status === 'reviewed') {
    return outcome.verdict;
  }
  const where = {
    episodeId: ctx.episodeId,
    subjectId: pair.subject.id,
    candidateId: pair.candidate.id,
  };
  if (outcome.status === 'failed') {
    const how = isAbortError(outcome.error) ? 'timed out' : 'failed';
    ctx.logger.warn({ err: outcome.error, ...where }, `contradiction review ${how}`);
    return vetoForUnansweredReview(`the second pass ${how}`);
  }
  ctx.logger.warn(where, 'contradiction review returned an invalid shape');
  return vetoForUnansweredReview('the second pass returned an answer in an unusable shape');
}

/** Whether this exact pair already carries a decision, applied or dismissed. */
function decidedAlready(ctx: StageContext, pair: JudgedPair): boolean {
  return findSupersessionProposalsForNode(ctx.db, pair.candidate.id).some(
    (row) =>
      row.oldId === pair.candidate.id && row.newId === pair.subject.id && row.resolvedAt !== null,
  );
}

/**
 * Read immediately before the write, and the classification is read off it. The candidate
 * search filtered on currency, so what this catches is currency lost since: the window is one
 * enrichment run, and inside it a family close takes siblings the same run went on to judge.
 * A single-writer worker makes the read and the write adjacent rather than atomic, and the
 * cost of losing that race is a repeat close, which `supersede` coalesces into a no-op.
 */
async function goneSides(ctx: StageContext, pair: JudgedPair): Promise<readonly string[]> {
  return findNodesWithoutCurrency(ctx.driver, [pair.candidate.id, pair.subject.id]);
}

async function applyUnanimous(
  ctx: StageContext,
  pair: JudgedPair,
  policy: SupersessionWritePolicy,
  tally: RunTally,
): Promise<JudgmentOutcome> {
  if (decidedAlready(ctx, pair)) {
    // Someone already ruled on this pair. Re-judging it does not reopen their decision, and a
    // second call spent arguing with it would change nothing.
    return 'already_decided';
  }

  const verdict = await secondPass(ctx, pair, policy);
  const second = describeVeto(verdict);
  if (verdict.outcome !== 'unanimous') {
    record(ctx, pair, second);
    tally.recordVeto();
    tally.recordProposal(pair.candidate.matchedBy === 'subject');
    return 'vetoed';
  }

  tally.recordUnanimous();
  const gone = await goneSides(ctx, pair);
  if (gone.length > 0) {
    // Nothing to close and nothing to review: the row is resolved so it does not sit in the
    // queue asking a person to apply a correction that has already happened.
    const id = record(ctx, pair, `${second}, and the target was already gone: ${gone.join(', ')}`);
    resolveSupersessionProposal(ctx.db, id, ctx.now.toISOString());
    tally.recordStaleTarget();
    return 'stale';
  }

  await applySupersessionProposal(ctx.driver, ctx.db, {
    id: record(ctx, pair, second),
    relatednessFloor: policy.familyRelatednessFloor,
    now: ctx.now,
    attribution: { provenance: [UNANIMOUS_APPLY_METHOD], signals: UNANIMOUS_APPLY_SIGNALS },
  });
  tally.recordSupersession();
  return 'closed';
}

/**
 * In `propose` mode the graph is never touched, so a re-run re-judges the same pair and
 * refreshes the one proposal row rather than adding a second. In the two applying modes the
 * close drops the old node out of the next run's candidate search, and both write paths are
 * no-ops on repeat: `supersede()` coalesces its stamps, and an applied proposal is resolved.
 */
export async function applyJudgment(
  ctx: StageContext,
  pair: JudgedPair,
  policy: SupersessionWritePolicy,
  tally: RunTally,
): Promise<JudgmentOutcome> {
  if (policy.mode === 'unanimous') {
    return await applyUnanimous(ctx, pair, policy, tally);
  }

  if (policy.mode === 'auto' && pair.confidence >= policy.autoConfidence) {
    // The same currency read the unanimous path runs, for the same reason: `supersede`
    // coalesces onto an already-closed node, so without this the legacy path counts a closure
    // that did not happen.
    if ((await goneSides(ctx, pair)).length > 0) {
      tally.recordStaleTarget();
      return 'stale';
    }
    await supersede(ctx.driver, {
      oldId: pair.candidate.id,
      newId: pair.subject.id,
      now: ctx.now,
      signals: ['contradiction'],
      provenance: [SUPERSESSION_METHOD],
    });
    tally.recordSupersession();
    return 'closed';
  }

  record(ctx, pair, undefined);
  tally.recordProposal(pair.candidate.matchedBy === 'subject');
  return 'proposed';
}
