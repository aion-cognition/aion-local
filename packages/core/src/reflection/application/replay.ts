import { ReflectionNotStoredError } from './errors.js';
import {
  projectEpisodeInTransaction,
  storeExperience,
  type ExperienceStoreDeps,
  type StoredEpisode,
} from './experience-store.js';
import type { ReflectionRun, ReflectionRunOptions } from './orchestrator.js';
import { attachProvenance } from './stated-references.js';
import { errorMessage } from '../../infrastructure/errors.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { abortRequested } from '../../infrastructure/providers/deadline-signal.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getExperienceById,
  listExperiencesAfter,
  type ExperienceArchiveCursor,
  type ExperienceArchiveFilter,
  type ExperienceArchiveRow,
} from '../../infrastructure/sqlite/experience-archive.js';
import {
  readSourcePartTurnIds,
  readSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { sourceResidencyState } from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  listSourceOccurrencesAfter,
  unrecordedArchiveRows,
  type OccurrenceFilter,
  type SourceOccurrence,
} from '../../infrastructure/sqlite/source-occurrence.js';
import { prepareEpisode, type PreparedEpisode } from '../domain/content.js';
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

/**
 * What a pass has seen so far, and where it stopped.
 *
 * A pass hands this to each phase rather than each phase returning a partial tally to merge: two
 * phases walk one run, and a caller's row limit and abort signal are answered against the whole
 * of it, not against whichever phase happens to be running.
 */
class ReplayPass {
  scanned = 0;
  aborted = false;
  cursor: ReplayCursor | undefined;
  readonly #counts: Record<keyof ReplayCounts, number> = {
    replayed: 0,
    skipped: 0,
    unavailable: 0,
    skippedEvicted: 0,
    failed: 0,
  };

  record(outcome: keyof ReplayCounts, cursor: ReplayCursor): void {
    this.#counts[outcome] += 1;
    this.scanned += 1;
    this.cursor = cursor;
  }

  counts(): ReplayCounts {
    return { ...this.#counts };
  }

  /** How many rows the next batch may take, or zero once the caller's row limit is spent. */
  batchSize(options: ReplayOptions): number {
    const remaining =
      options.limit === undefined ? options.batchSize : options.limit - this.scanned;
    return Math.min(options.batchSize, remaining);
  }

  /** True when the caller has stopped asking, which is checked per row rather than per batch. */
  stopped(signal: AbortSignal | undefined): boolean {
    if (abortRequested(signal)) {
      this.aborted = true;
    }
    return this.aborted;
  }
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
  sourceId: string,
  pipelineVersion: string,
  now: Date,
): Promise<ReflectionRun> {
  // The stated references are archived beside the content and were never in the hash, so they
  // come back out before the payload is re-prepared: folding them in would hash to a different
  // episode than the one the archive names. Re-stating them is also the repair path for an
  // intake whose graph write failed, and every write behind it is idempotent, so a row whose
  // references already landed is a no-op.
  const { provenance, ...content } = row.payload;
  // The occurrence's own recorded world time, when it has one: a replacement sharing a forgotten
  // predecessor's bytes has its own clock, and the raw row carries the predecessor's.
  const record = readSourceRecord(deps.db, sourceId);
  const prepared = prepareEpisode(content, new Date(record?.occurredAt ?? row.occurredAt));
  const stored = await projectRow(deps, row, sourceId, prepared, now);
  await attachProvenance(deps, stored.episodeId, provenance, now);
  return deps.runner.run(stored.episodeId, { now, pipelineVersion });
}

/**
 * The episode this row is, under the id the records already carry.
 *
 * Identity comes from the occurrence record rather than from a content-hash lookup in the
 * graph: the lookup answers only while the projection is there, and a replay is exactly the
 * pass that runs after it may not be. A row the records do not know yet is a legacy one, and it
 * takes the old path so the first replay of an unbackfilled substrate still works.
 */
async function projectRow(
  deps: ReplayDeps,
  row: ExperienceArchiveRow,
  sourceId: string,
  prepared: PreparedEpisode,
  now: Date,
): Promise<StoredEpisode> {
  const record = readSourceRecord(deps.db, sourceId);
  if (record === undefined) {
    return (await storeExperience(deps, prepared, row.identity, now, row.origin)).stored;
  }
  const turnIds = readSourcePartTurnIds(deps.db, sourceId);
  if (turnIds.length !== prepared.turns.length) {
    throw new Error(
      `source ${sourceId} records ${String(turnIds.length)} turn parts for ${String(prepared.turns.length)} archived turns`,
    );
  }
  await deps.sessions.ensureSession({
    identity: row.identity,
    now,
    occurredAt: prepared.occurredAt,
  });
  return inWriteTransaction(deps.driver, (tx) =>
    projectEpisodeInTransaction(tx, {
      prepared,
      sessionId: record.sessionId,
      origin: row.origin,
      now,
      identity: { episodeId: sourceId, turnIds },
    }),
  );
}

/**
 * A row that throws is counted and the pass continues: one payload the pipeline chokes on is
 * not a reason to strand every row behind it. A graph the runner cannot reach is the one
 * exception, since every remaining row would fail the same way.
 */
async function rowOutcome(
  deps: ReplayDeps,
  row: ExperienceArchiveRow,
  sourceId: string,
  pipelineVersion: string,
  now: Date,
): Promise<keyof ReplayCounts> {
  if (sourceResidencyState(deps.db, sourceId) === 'evicted') {
    deps.logger.info(
      { archiveId: row.id, episodeId: sourceId },
      'replay skipped an evicted source; its projection returns through rebuild, not through replay',
    );
    return 'skippedEvicted';
  }
  try {
    const run = await replayRow(deps, row, sourceId, pipelineVersion, now);
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
      { err: errorMessage(err), archiveId: row.id, episodeId: sourceId },
      'replay of an archived experience failed; continuing with the rest',
    );
    return 'failed';
  }
}

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

  await walkOccurrences(deps, options, pass, state);
  const unrecorded = unrecordedArchiveRows(deps.db);
  if (!state.aborted && unrecorded > 0) {
    await walkUnrecorded(deps, options, pass, state);
  }

  deps.logger.info(
    {
      ...state.counts(),
      scanned: state.scanned,
      pipelineVersion: pass.pipelineVersion,
      unrecorded,
      aborted: state.aborted,
    },
    'replay finished',
  );
  return {
    ...state.counts(),
    scanned: state.scanned,
    cursor: state.cursor,
    unrecorded,
    aborted: state.aborted,
  };
}

type PassOptions = {
  readonly pipelineVersion: string;
  readonly clock: () => Date;
  readonly selection: ReplaySelection;
};

function report(state: ReplayPass, options: ReplayOptions): void {
  if (state.cursor !== undefined) {
    options.onBatch?.({ ...state.counts(), scanned: state.scanned, cursor: state.cursor });
  }
}

async function walkOccurrences(
  deps: ReplayDeps,
  options: ReplayOptions,
  pass: PassOptions,
  state: ReplayPass,
): Promise<void> {
  const filter: OccurrenceFilter = {
    ...(pass.selection.stale === true ? { excludePipelineVersion: pass.pipelineVersion } : {}),
    ...(pass.selection.episodeId === undefined ? {} : { sourceId: pass.selection.episodeId }),
    ...(pass.selection.sessionId === undefined ? {} : { sessionId: pass.selection.sessionId }),
  };
  let position = 0;
  for (;;) {
    const size = state.batchSize(options);
    if (state.stopped(options.signal) || size <= 0) {
      return;
    }
    const page = listSourceOccurrencesAfter(deps.db, position, size, filter);
    if (page.length === 0) {
      return;
    }
    for (const occurrence of page) {
      if (state.stopped(options.signal)) {
        break;
      }
      const row =
        occurrence.canonicalArchiveId === null
          ? undefined
          : getExperienceById(deps.db, occurrence.canonicalArchiveId);
      const outcome = await occurrenceOutcome(deps, occurrence, row, pass);
      position = occurrence.ingestPosition;
      state.record(outcome, { kind: 'ingest', position });
    }
    report(state, options);
    if (state.aborted) {
      return;
    }
  }
}

/**
 * An occurrence whose canonical row is missing cannot be re-derived from anything, so it counts
 * as unavailable rather than failed: nothing is wrong with the pass, and the raw bytes are what
 * is absent.
 */
async function occurrenceOutcome(
  deps: ReplayDeps,
  occurrence: SourceOccurrence,
  row: ExperienceArchiveRow | undefined,
  pass: PassOptions,
): Promise<keyof ReplayCounts> {
  if (row === undefined) {
    deps.logger.warn(
      { episodeId: occurrence.sourceId },
      'replay skipped an occurrence whose canonical archive row is missing',
    );
    return 'unavailable';
  }
  return rowOutcome(deps, row, occurrence.sourceId, pass.pipelineVersion, pass.clock());
}

/** The pre-backfill tail: archive rows no occurrence record names, by the old archive keyset. */
async function walkUnrecorded(
  deps: ReplayDeps,
  options: ReplayOptions,
  pass: PassOptions,
  state: ReplayPass,
): Promise<void> {
  const filter: ExperienceArchiveFilter = {
    ...(pass.selection.stale === true ? { excludePipelineVersion: pass.pipelineVersion } : {}),
    ...(pass.selection.episodeId === undefined ? {} : { episodeId: pass.selection.episodeId }),
    ...(pass.selection.sessionId === undefined ? {} : { sessionId: pass.selection.sessionId }),
  };
  let cursor: ExperienceArchiveCursor | undefined;
  for (;;) {
    const size = state.batchSize(options);
    if (state.stopped(options.signal) || size <= 0) {
      return;
    }
    const rows = listExperiencesAfter(deps.db, cursor, size, filter);
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      if (state.stopped(options.signal)) {
        break;
      }
      cursor = { occurredAt: row.occurredAt, id: row.id };
      // Already visited as an occurrence; walking it again would run the same source twice.
      if (readSourceRecord(deps.db, row.episodeId) === undefined) {
        const outcome = await rowOutcome(
          deps,
          row,
          row.episodeId,
          pass.pipelineVersion,
          pass.clock(),
        );
        state.record(outcome, { kind: 'archive', ...cursor });
      }
    }
    report(state, options);
    if (state.aborted) {
      return;
    }
  }
}
