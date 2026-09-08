import {
  ReplayPass,
  walkCohorts,
  walkOccurrences,
  walkUnrecorded,
  type PassOptions,
} from './replay-phases.js';
import type { ReplayDeps, ReplayOptions, ReplayReport } from './replay-types.js';
import { unrecordedArchiveRows } from '../../infrastructure/sqlite/source-occurrence.js';
import { PIPELINE_VERSION } from '../domain/version.js';

export type {
  ReplayCounts,
  ReplayCursor,
  ReplayDeps,
  ReplayOptions,
  ReplayProgress,
  ReplayReport,
  ReplayRunner,
  ReplaySelection,
} from './replay-types.js';

/**
 * Archived experiences put back through the pipeline. The archive is the record of what the
 * substrate was told; a replay derives the graph from it again, which is what makes a prompt
 * or extraction change a re-run rather than a migration.
 *
 * Replay never touches the queue. It stores the experience and runs the orchestrator itself,
 * so a bulk pass cannot demote live sessions through the lane assigner's arrival counters.
 *
 * Two clocks run through a replay. World time is the occurrence's own `occurred_at`, and
 * `valid_from` is stamped from it, so a re-derived node is dated to when the thing happened.
 * Transaction time is the replay's own moment: `tx_from`, `tx_until` and every lock take the
 * wall clock, because the substrate learned this today. Handing one clock to both writes a
 * transaction history into the past, which is a record of a write that never happened.
 */
/**
 * Every selected occurrence, then the archive rows no occurrence record accounts for yet.
 *
 * The first pass is the one that matters: occurrences are what a caller selects and what
 * residency, clocks and part identity are recorded against, and a replacement sharing a
 * forgotten predecessor's canonical row is only reachable this way. Walking archive rows would
 * visit the predecessor's bytes once and never the source that is actually here.
 *
 * The second pass is an explicit fallback for a substrate whose records have not been
 * backfilled. It is reported separately rather than folded in, so a run cannot look complete on
 * the strength of rows nothing has classified.
 */
export async function replayExperiences(
  deps: ReplayDeps,
  options: ReplayOptions,
): Promise<ReplayReport> {
  const pass: PassOptions = {
    pipelineVersion: options.pipelineVersion ?? PIPELINE_VERSION,
    clock: options.clock ?? ((): Date => new Date()),
    selection: options.selection ?? {},
  };
  const state = new ReplayPass();

  const resume = options.cursor?.kind;
  if (resume === undefined || resume === 'ingest') {
    await walkOccurrences(deps, options, pass, state);
  }
  let cohortMembers = 0;
  if (!state.aborted && resume !== 'archive') {
    cohortMembers = await walkCohorts(deps, options, pass, state);
  }
  const unrecorded = unrecordedArchiveRows(deps.db);
  if (!state.aborted && unrecorded > 0) {
    await walkUnrecorded(deps, options, pass, state);
  }

  deps.logger.info(
    {
      ...state.counts(),
      scanned: state.scanned,
      pipelineVersion: pass.pipelineVersion,
      cohortMembers,
      unrecorded,
      aborted: state.aborted,
    },
    'replay finished',
  );
  return {
    ...state.counts(),
    scanned: state.scanned,
    cursor: state.cursor,
    cohortMembers,
    unrecorded,
    aborted: state.aborted,
  };
}
