import type { ReflectionRun } from './orchestrator.js';
import type { ReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';

/**
 * What the worker says about a job, in the two places a reader looks: the queue row's error
 * field and the episode a payload names.
 */

/**
 * What actually went wrong, in the one field an operator reads: the queue row's `last_error`.
 * The old message claimed nothing enriched, which was false the first time it was measured,
 * with eight of nine stages applied and one timed out, and is further from true now that
 * the ledger is per stage, since a retry re-enters only what failed and every other stage is
 * already applied before the run starts.
 */
export function describeFailedRun(episodeId: string, run: ReflectionRun): string {
  const failed = run.summary.stages.filter((stage) => stage.status === 'failed');
  if (failed.length === 0) {
    return `no stage enriched ${episodeId}`;
  }
  const named = failed.map((stage) => `${stage.name}: ${stage.error ?? stage.summary}`).join('; ');
  const skipped = run.summary.skippedStages;
  const context = skipped.length === 0 ? '' : ` (${String(skipped.length)} stages already applied)`;
  return `${String(failed.length)} stage(s) failed for ${episodeId}${context}: ${named}`;
}

/** Intake writes `{ episode_id }` and nothing else enqueues an integrate job. */
export function episodeIdOf(job: ReflectionJob): string | undefined {
  const payload = job.payload as { episode_id?: unknown } | null | undefined;
  const episodeId = payload?.episode_id;
  if (typeof episodeId === 'string' && episodeId !== '') {
    return episodeId;
  }
  return undefined;
}
