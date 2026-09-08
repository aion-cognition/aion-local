import type { ReflectionProvenance } from '@aion/protocol';

import { ReflectionNotStoredError } from './errors.js';
import {
  projectEpisodeInTransaction,
  storeExperience,
  type StoredEpisode,
} from './experience-store.js';
import type { ReflectionRun } from './orchestrator.js';
import { acceptedReferencesOf } from './reference-acceptance.js';
import {
  referenceStatementsOf,
  type ConfirmationStatement,
  type ReferenceStatements,
} from './reference-statements.js';
import type {
  ReplayCounts,
  ReplayCursor,
  ReplayDeps,
  ReplayOptions,
  ReplaySelection,
} from './replay-types.js';
import { attachProvenance } from './stated-references.js';
import { errorMessage } from '../../infrastructure/errors.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { abortRequested } from '../../infrastructure/providers/deadline-signal.js';
import {
  getExperienceById,
  listExperiencesAfter,
  type ExperienceArchiveCursor,
  type ExperienceArchiveFilter,
  type ExperienceArchiveRow,
} from '../../infrastructure/sqlite/experience-archive.js';
import {
  listCohortSourcesAfter,
  listMigrationCohorts,
  type CohortSourceFilter,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  readSourcePartTurnIds,
  readSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { sourceResidencyState } from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  listSourceOccurrencesAfter,
  type OccurrenceFilter,
  type SourceOccurrence,
} from '../../infrastructure/sqlite/source-occurrence.js';
import { prepareEpisode, type PreparedEpisode } from '../domain/content.js';

/**
 * What a pass has seen so far, and where it stopped.
 *
 * A pass hands this to each phase rather than each phase returning a partial tally to merge: two
 * phases walk one run, and a caller's row limit and abort signal are answered against the whole
 * of it, not against whichever phase happens to be running.
 */
export class ReplayPass {
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
  await attachProvenance(
    deps,
    stored.episodeId,
    statementsOf(deps, row, sourceId, provenance),
    now,
  );
  return deps.runner.run(stored.episodeId, { now, pipelineVersion });
}

/**
 * What THIS occurrence stated, which is not what its raw row carries.
 *
 * The accepted history is the answer for every occurrence, its own row's owner included: a
 * registered acceptance records statements durably and need not put them in the payload at all,
 * so a source that reads only its archive block loses the references it actually holds and a
 * rebuilt projection comes back without them.
 *
 * The block survives as a compatibility fallback for statements no acceptance has materialized
 * yet, and only for the source whose own row it is. A replacement never reads it: those
 * statements belong to the predecessor, and re-stating them here would assert them under an
 * occurrence that never made them.
 *
 * Statements still awaiting their acknowledgment are absent on purpose. They are owed to the
 * publication that prepared them, and replaying one would publish a decision that publication
 * may still refuse; leaving it out discharges nothing.
 *
 * The two halves are unioned over the targets they name, and where both name one the accepted
 * version keeps it. The block is a fallback, not a correction: an occurrence whose block and
 * whose records disagree about who confirmed a target has a proof to repair, and repairing it
 * belongs to whoever produces that proof rather than to a replay quietly taking the later text.
 */
function statementsOf(
  deps: ReplayDeps,
  row: ExperienceArchiveRow,
  sourceId: string,
  archived: ReflectionProvenance | undefined,
): ReferenceStatements | undefined {
  const legacy =
    row.episodeId === sourceId && archived !== undefined
      ? referenceStatementsOf(archived)
      : undefined;
  const accepted = acceptedReferencesOf(deps.db, sourceId);
  if (accepted === undefined) {
    return legacy;
  }
  const confirmations = new Map<string, ConfirmationStatement>(
    accepted.confirmations.map((entry) => [entry.target, entry] as const),
  );
  for (const entry of legacy?.confirmations ?? []) {
    if (!confirmations.has(entry.target)) {
      confirmations.set(entry.target, entry);
    }
  }
  return {
    supersedes: [...new Set([...accepted.supersedes, ...(legacy?.supersedes ?? [])])],
    derivedFrom: [...new Set([...accepted.derivedFrom, ...(legacy?.derivedFrom ?? [])])],
    confirmations: [...confirmations.values()],
  };
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

export type PassOptions = {
  readonly pipelineVersion: string;
  readonly clock: () => Date;
  readonly selection: ReplaySelection;
};

function report(state: ReplayPass, options: ReplayOptions): void {
  if (state.cursor !== undefined) {
    options.onBatch?.({ ...state.counts(), scanned: state.scanned, cursor: state.cursor });
  }
}

export async function walkOccurrences(
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
  let position = options.cursor?.kind === 'ingest' ? options.cursor.position : 0;
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
  occurrence: Pick<SourceOccurrence, 'sourceId' | 'canonicalArchiveId'>,
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

/**
 * The frozen cohorts, which the live order cannot reach.
 *
 * A legacy source was already in the substrate when its cohort was taken, so it has no ingest
 * position and the live walk skips it; the raw fallback skips it too, because its occurrence IS
 * recorded. The frozen membership is its own cursor, and the migration job producing that
 * membership does not discharge a consumer's obligation to walk it.
 *
 * Returns how many members this pass visited.
 */
export async function walkCohorts(
  deps: ReplayDeps,
  options: ReplayOptions,
  pass: PassOptions,
  state: ReplayPass,
): Promise<number> {
  const resume = options.cursor?.kind === 'cohort' ? options.cursor : undefined;
  const filter: CohortSourceFilter = {
    ...(pass.selection.stale === true ? { excludePipelineVersion: pass.pipelineVersion } : {}),
    ...(pass.selection.episodeId === undefined ? {} : { sourceId: pass.selection.episodeId }),
    ...(pass.selection.sessionId === undefined ? {} : { sessionId: pass.selection.sessionId }),
  };
  const cohorts = listMigrationCohorts(deps.db);
  const start = resume === undefined ? 0 : Math.max(0, cohorts.indexOf(resume.cohortId));
  let visited = 0;
  for (const cohortId of cohorts.slice(start)) {
    let after = cohortId === resume?.cohortId ? resume.sourceId : '';
    for (;;) {
      const size = state.batchSize(options);
      if (state.stopped(options.signal) || size <= 0) {
        return visited;
      }
      const page = listCohortSourcesAfter(deps.db, cohortId, after, size, filter);
      if (page.length === 0) {
        break;
      }
      for (const member of page) {
        if (state.stopped(options.signal)) {
          break;
        }
        const row =
          member.canonicalArchiveId === null
            ? undefined
            : getExperienceById(deps.db, member.canonicalArchiveId);
        const outcome = await occurrenceOutcome(
          deps,
          { sourceId: member.sourceId, canonicalArchiveId: member.canonicalArchiveId },
          row,
          pass,
        );
        after = member.sourceId;
        visited += 1;
        state.record(outcome, { kind: 'cohort', cohortId, sourceId: after });
      }
      report(state, options);
      if (state.aborted) {
        return visited;
      }
    }
  }
  return visited;
}

/** The pre-backfill tail: archive rows no occurrence record names, by the old archive keyset. */
export async function walkUnrecorded(
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
  let cursor: ExperienceArchiveCursor | undefined =
    options.cursor?.kind === 'archive'
      ? { occurredAt: options.cursor.occurredAt, id: options.cursor.id }
      : undefined;
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
