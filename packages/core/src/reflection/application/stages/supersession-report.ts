import type { SupersessionMode } from './supersession-apply.js';
import type { RunTally } from './supersession-tally.js';
import { describeError } from '../../../infrastructure/errors.js';
import type { StageOutcome } from '../../domain/stage.js';

/**
 * What one supersession run reports. Split out of the stage so the counters, the retryable
 * dispositions and the summary line stay in one place and the stage file stays inside the
 * repository's line cap.
 */

export function reportRun(
  tally: RunTally,
  writeError: unknown,
  mode: SupersessionMode,
): StageOutcome {
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
  const stale = mode === 'propose' ? '' : `, ${tally.staleTargets} with the target already gone`;
  const review =
    mode === 'unanimous'
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
      `${tally.judgments} contradiction judgment(s) in ${mode} mode: ` +
      `${tally.superseded} superseded, ${tally.proposed} proposed for review ` +
      `(${tally.proposedBySubject} by shared subject)` +
      `${tally.withheld === 0 ? '' : `, ${tally.withheld} withheld`}${review}${stale}`,
    counts,
  };
}
