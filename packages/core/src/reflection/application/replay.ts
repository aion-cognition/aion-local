import { ReflectionNotStoredError } from './errors.js';
import { storeExperience, type ExperienceStoreDeps } from './experience-store.js';
import type { ReflectionRun, ReflectionRunOptions } from './orchestrator.js';
import { errorMessage } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { abortRequested } from '../../infrastructure/providers/deadline-signal.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listExperiencesAfter,
  type ExperienceArchiveCursor,
  type ExperienceArchiveFilter,
  type ExperienceArchiveRow,
} from '../../infrastructure/sqlite/experience-archive.js';
import { prepareEpisode } from '../domain/content.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * Archived experiences put back through the pipeline. The archive is the record of what the
 * substrate was told; a replay derives the graph from it again, which is what makes a prompt
 * or extraction change a re-run rather than a migration.
 *
 * Replay never touches the queue. It stores the experience and runs the orchestrator itself,
 * so a bulk pass cannot demote live sessions through the lane assigner's arrival counters.
 *
 * Two clocks run through a replay. World time is the archived experience's `occurred_at`, and
 * `valid_from` is stamped from it, so a re-derived node is dated to when the thing happened.
 * Transaction time is the replay's own moment: `tx_from`, `tx_until` and every
 * lock take the wall clock, because the substrate learned this today. Handing one clock to both
 * writes a transaction history into the past, which is a record of a write that never happened.
 *
 * A row already enriched under this pipeline version costs one graph read and one SQLite
 * point read: the re-derived payload hashes to the episode the archive names, and the
 * orchestrator's run-level ledger gate answers before a stage is entered. Under a bumped
 * version the key space forks and every stage runs again.
 */

/** The orchestrator, narrowed to what a replay asks of it. */
export type ReplayRunner = {
  run: (episodeId: string, options: ReflectionRunOptions) => Promise<ReflectionRun>;
};

export type ReplayDeps = ExperienceStoreDeps & {
  readonly db: SqliteHandle;
  readonly runner: ReplayRunner;
  readonly logger: Logger;
};

export type ReplaySelection = {
  /** Only rows archived under some other pipeline version. False replays every row. */
  readonly stale?: boolean;
  readonly episodeId?: string;
  readonly sessionId?: string;
};

export type ReplayOptions = {
  readonly selection?: ReplaySelection;
  /** Which fork of the ledger key space the runs gate on. Defaults to the shipped version. */
  readonly pipelineVersion?: string;
  readonly batchSize: number;
  /** Rows visited at most, across every batch. Unbounded when absent. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
  /**
   * The wall clock, read once per row and handed to that row's write and run as their
   * transaction clock. World time never comes from here: it comes off the archived row. A
   * minutes-long pass therefore stamps each row at the moment it was actually written.
   */
  readonly clock?: () => Date;
  /** Called once per batch, so a minutes-long run reports progress rather than one line at the end. */
  readonly onBatch?: (progress: ReplayProgress) => void;
};

export type ReplayCounts = {
  /** Rows whose run entered the stages. */
  readonly replayed: number;
  /** Rows the ledger already held under this pipeline version. */
  readonly skipped: number;
  /** Rows whose episode the graph could not read back. */
  readonly unavailable: number;
  readonly failed: number;
};

export type ReplayProgress = ReplayCounts & {
  readonly scanned: number;
  readonly cursor: ExperienceArchiveCursor;
};

export type ReplayReport = ReplayCounts & {
  readonly scanned: number;
  /** Where the run stopped, so an aborted pass resumes instead of starting over. */
  readonly cursor: ExperienceArchiveCursor | undefined;
  readonly aborted: boolean;
};

type Tally = {
  scanned: number;
  replayed: number;
  skipped: number;
  unavailable: number;
  failed: number;
};

function filterOf(selection: ReplaySelection, pipelineVersion: string): ExperienceArchiveFilter {
  return {
    ...(selection.stale === true ? { excludePipelineVersion: pipelineVersion } : {}),
    ...(selection.episodeId === undefined ? {} : { episodeId: selection.episodeId }),
    ...(selection.sessionId === undefined ? {} : { sessionId: selection.sessionId }),
  };
}

function countsOf(tally: Tally): ReplayCounts {
  return {
    replayed: tally.replayed,
    skipped: tally.skipped,
    unavailable: tally.unavailable,
    failed: tally.failed,
  };
}

/**
 * One archived experience through the pipeline again. The payload is re-prepared from what the
 * archive holds, which is the redacted content the first intake hashed, so it resolves to the
 * episode the row names instead of writing a second one.
 *
 * The row's stamp reaches the write only through `prepared`, which is where world time lives:
 * it dates the episode and stands in for a turn that carries no timestamp of its own. `now` is
 * the replay's moment and goes nowhere else. The orchestrator takes world time from the episode
 * node it reads back, not from the clock passed here.
 */
async function replayRow(
  deps: ReplayDeps,
  row: ExperienceArchiveRow,
  pipelineVersion: string,
  now: Date,
): Promise<ReflectionRun> {
  const prepared = prepareEpisode(row.payload, new Date(row.occurredAt));
  const { stored } = await storeExperience(deps, prepared, row.identity, now, row.origin);
  return deps.runner.run(stored.episodeId, { now, pipelineVersion });
}

/**
 * A row that throws is counted and the pass continues: one payload the pipeline chokes on is
 * not a reason to strand every row behind it. A graph the runner cannot reach is the one
 * exception, since every remaining row would fail the same way.
 */
async function rowOutcome(
  deps: ReplayDeps,
  row: ExperienceArchiveRow,
  pipelineVersion: string,
  now: Date,
): Promise<keyof ReplayCounts> {
  try {
    const run = await replayRow(deps, row, pipelineVersion, now);
    if (run.status === 'already_applied') {
      return 'skipped';
    }
    if (run.status === 'episode_unavailable') {
      return 'unavailable';
    }
    return 'replayed';
  } catch (err) {
    if (err instanceof ReflectionNotStoredError) {
      throw err;
    }
    deps.logger.error(
      { err: errorMessage(err), archiveId: row.id, episodeId: row.episodeId },
      'replay of an archived experience failed; continuing with the rest',
    );
    return 'failed';
  }
}

/**
 * Oldest first, by the `(occurred_at, id)` keyset the archive indexes on. Ordering that way
 * puts the experiences nothing else will ever pick up at the front, and the cursor survives an
 * abort because a replay writes nothing to the table it is reading.
 */
export async function replayExperiences(
  deps: ReplayDeps,
  options: ReplayOptions,
): Promise<ReplayReport> {
  const pipelineVersion = options.pipelineVersion ?? PIPELINE_VERSION;
  const clock = options.clock ?? ((): Date => new Date());
  const filter = filterOf(options.selection ?? {}, pipelineVersion);
  const tally: Tally = { scanned: 0, replayed: 0, skipped: 0, unavailable: 0, failed: 0 };
  let cursor: ExperienceArchiveCursor | undefined;
  let aborted = false;

  for (;;) {
    if (abortRequested(options.signal)) {
      aborted = true;
      break;
    }
    const remaining =
      options.limit === undefined ? options.batchSize : options.limit - tally.scanned;
    const size = Math.min(options.batchSize, remaining);
    if (size <= 0) {
      break;
    }

    const rows = listExperiencesAfter(deps.db, cursor, size, filter);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      // Checked per row, not per batch: a row is a full orchestrator run, so waiting out the
      // batch would spend minutes on work the caller has already stopped asking for. The
      // cursor stays at the last completed row, which is where the next pass resumes.
      if (abortRequested(options.signal)) {
        aborted = true;
        break;
      }
      tally[await rowOutcome(deps, row, pipelineVersion, clock())] += 1;
      tally.scanned += 1;
      cursor = { occurredAt: row.occurredAt, id: row.id };
    }
    if (cursor !== undefined) {
      options.onBatch?.({ ...countsOf(tally), scanned: tally.scanned, cursor });
    }
    if (aborted) {
      break;
    }
  }

  deps.logger.info(
    { ...countsOf(tally), scanned: tally.scanned, pipelineVersion, aborted },
    'replay finished',
  );
  return { ...countsOf(tally), scanned: tally.scanned, cursor, aborted };
}
