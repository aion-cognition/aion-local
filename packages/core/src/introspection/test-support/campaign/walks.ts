import type { Driver } from 'neo4j-driver';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { exportCohort } from './export.js';
import {
  readGraphSourcePage,
  readNarrativeEdgeStatePage,
  readNarrativePage,
  type GraphSourceRow,
  type NarrativeEdgeState,
  type NarrativeRow,
} from '../../../infrastructure/graph/campaign-cohort-queries.js';
import {
  readArchiveShapePage,
  type ArchiveRecordShape,
} from '../../../infrastructure/sqlite/campaign-archive-reads.js';
import { sqliteTableExists, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { GaugeUnavailableReason } from '../../domain/campaign-gauges.js';
import { COHORT_PAGE_BOUNDS, type PageShape } from '../../domain/campaign-paging.js';

/**
 * Each cohort walk, isolated from the others.
 *
 * One store refusing to answer is a fact about that store. A collector that lets the refusal
 * reject the whole run throws away every reading it already took and leaves nothing to report
 * except the exception, so each walk here comes back as its own outcome and the caller turns a
 * failure into unavailable readings rather than into no readings at all.
 *
 * The graph walks go through the durable export, so the numbers reported are read back from
 * the pages that were persisted rather than from an accumulator that only ever existed in
 * memory.
 */

export type WalkOutcome<T> =
  | { readonly status: 'ok'; readonly rows: readonly T[]; readonly exportComplete: boolean }
  | {
      readonly status: 'failed';
      readonly reason: GaugeUnavailableReason;
      readonly detail: string;
    };

const PAGE_ROWS = COHORT_PAGE_BOUNDS.maxRows;

/** Reads back what the export persisted, which is what the report is allowed to cite. */
function readExportedRows(dir: string, name: string): readonly unknown[] {
  const files = readdirSync(join(dir, name))
    .filter((file) => file.startsWith('page-'))
    .sort();
  const rows: unknown[] = [];
  for (const file of files) {
    const page = JSON.parse(readFileSync(join(dir, name, file), 'utf8')) as { rows: unknown[] };
    rows.push(...page.rows);
  }
  return rows;
}

async function exportedWalk<T>(
  name: string,
  dir: string,
  fetch: (cursor: string | undefined, limit: number) => Promise<readonly T[]>,
  shape: PageShape<T>,
): Promise<WalkOutcome<T>> {
  try {
    const result = await exportCohort({ name, dir, fetch, shape });
    return {
      status: 'ok',
      rows: readExportedRows(dir, name) as readonly T[],
      exportComplete: result.complete,
    };
  } catch (err) {
    return { status: 'failed', reason: 'collector_failed', detail: String(err) };
  }
}

/** Serialized size of one metadata row, which is what a page ceiling is priced on. */
function jsonBytes(row: unknown): number {
  return Buffer.byteLength(JSON.stringify(row), 'utf8');
}

export async function walkNarrativeEdges(
  driver: Driver,
  dir: string,
): Promise<WalkOutcome<NarrativeEdgeState>> {
  return exportedWalk<NarrativeEdgeState>(
    'narrative-edges',
    dir,
    (cursor, limit) => readNarrativeEdgeStatePage(driver, limit, cursor),
    { key: (row) => row.id, bytes: jsonBytes },
  );
}

export async function walkGraphSources(
  driver: Driver,
  dir: string,
): Promise<WalkOutcome<GraphSourceRow>> {
  return exportedWalk<GraphSourceRow>(
    'graph-sources',
    dir,
    (cursor, limit) => readGraphSourcePage(driver, limit, cursor),
    { key: (row) => row.id, bytes: jsonBytes },
  );
}

export async function walkNarratives(
  driver: Driver,
  dir: string,
): Promise<WalkOutcome<NarrativeRow>> {
  return exportedWalk<NarrativeRow>(
    'narratives',
    dir,
    (cursor, limit) => readNarrativePage(driver, limit, cursor),
    { key: (row) => row.id, bytes: jsonBytes },
  );
}

/**
 * The archive walk stays in memory: it reads a file this process opened read-only, and the
 * frozen membership it feeds is the archive census rather than a graph cohort.
 */
export function walkArchive(db: SqliteHandle | undefined): WalkOutcome<ArchiveRecordShape> {
  if (db === undefined) {
    return { status: 'failed', reason: 'store_unavailable', detail: 'no substrate was reachable' };
  }
  if (!sqliteTableExists(db, 'experience_archive')) {
    return {
      status: 'failed',
      reason: 'not_installed',
      detail: 'the substrate holds no experience_archive table',
    };
  }
  try {
    const all: ArchiveRecordShape[] = [];
    let cursor: { occurredAt: string; id: string } | undefined;
    for (;;) {
      const page = readArchiveShapePage(db, cursor, PAGE_ROWS);
      if (page.length === 0) {
        return { status: 'ok', rows: all, exportComplete: true };
      }
      all.push(...page);
      const last = page[page.length - 1];
      cursor = last === undefined ? undefined : { occurredAt: last.occurredAt, id: last.id };
    }
  } catch (err) {
    return { status: 'failed', reason: 'collector_failed', detail: String(err) };
  }
}

/** One graph reading, isolated the same way a walk is. */
export async function reading<T>(run: () => Promise<T>): Promise<WalkOutcome<T>> {
  try {
    return { status: 'ok', rows: [await run()], exportComplete: true };
  } catch (err) {
    return { status: 'failed', reason: 'collector_failed', detail: String(err) };
  }
}
