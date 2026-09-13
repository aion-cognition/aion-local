import type { ExperienceStoreDeps } from './experience-store.js';
import type { ReflectionRun, ReflectionRunOptions } from './orchestrator.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { ExperienceArchiveCursor } from '../../infrastructure/sqlite/experience-archive.js';

/**
 * What a replay is asked for and what it answers with.
 *
 * These live apart from both the driver and its phases because both speak them: a phase records
 * into the pass, and the driver reports what the phases left. One copy keeps them describing the
 * same run.
 */
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
   * Where to resume. Its kind names the phase to resume in, and the phases before it are
   * already done, so a resumed pass never re-walks a population an earlier one finished.
   */
  readonly cursor?: ReplayCursor;
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
  /**
   * Rows whose source no longer has a raw projection. An ordinary replay never rebuilds one:
   * the stage pipeline needs graph context, and inventing a projection to satisfy it is the
   * implicit rehydration the residency rules forbid. The skip discharges nothing the source
   * owes, and `aion rebuild` is the path that puts the projection back.
   */
  readonly skippedEvicted: number;
  readonly failed: number;
};

/**
 * Where a pass stopped.
 *
 * The live enumeration walks occurrences in ingest order, and its position is a number handed
 * out once and never reused: a backdated arrival cannot slip behind a mark an earlier pass
 * already passed, which world time allows. The archive keyset is the explicit fallback for rows
 * no occurrence record accounts for yet, and it says so by its kind.
 */
export type ReplayCursor =
  | { readonly kind: 'ingest'; readonly position: number }
  | ({ readonly kind: 'archive' } & ExperienceArchiveCursor);

export type ReplayProgress = ReplayCounts & {
  readonly scanned: number;
  readonly cursor: ReplayCursor;
};

export type ReplayReport = ReplayCounts & {
  readonly scanned: number;
  /** Where the run stopped, so an aborted pass resumes instead of starting over. */
  readonly cursor: ReplayCursor | undefined;
  /** Archive rows no occurrence record accounts for, which the fallback pass visited. */
  readonly unrecorded: number;
  readonly aborted: boolean;
};
