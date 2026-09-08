import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  advanceProgress,
  boundPage,
  COHORT_PAGE_BOUNDS,
  EMPTY_PROGRESS,
  exportIsComplete,
  recordOversizedExport,
  type ExportProgress,
  type PageBounds,
  type PageShape,
} from '../../domain/campaign-paging.js';

/**
 * A cohort export that survives being killed.
 *
 * Each page is written before the record that says it was written, and the record carries the
 * cursor the next fetch resumes from. A run that dies between pages restarts from the last
 * record rather than from the beginning, and a run that dies mid-transfer restarts owing the
 * same oversized member, because that member is marked exported only after its own bytes and
 * their checksum are on disk.
 *
 * Everything is written under a directory the caller names, never back into a store.
 */

const PROGRESS_FILE = 'progress.json';
const PAGE_PREFIX = 'page-';

export type CohortFetch<T> = (
  cursor: string | undefined,
  limit: number,
) => Promise<readonly T[]> | readonly T[];

export type CohortExportResult = {
  readonly name: string;
  readonly pages: number;
  readonly members: readonly string[];
  readonly oversized: readonly string[];
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly duplicated: readonly string[];
};

function progressPath(dir: string, name: string): string {
  return join(dir, name, PROGRESS_FILE);
}

function readProgress(dir: string, name: string): ExportProgress {
  try {
    return JSON.parse(readFileSync(progressPath(dir, name), 'utf8')) as ExportProgress;
  } catch {
    // No record yet, or one nothing can read. Either way the walk starts over, which is safe:
    // the completeness check names a member visited twice.
    return EMPTY_PROGRESS;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Content first, then its digest, then the record that says the transfer happened. */
function streamOversized(dir: string, name: string, key: string, row: unknown): void {
  const body = `${JSON.stringify(row, null, 2)}\n`;
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
  writeFileSync(join(dir, name, 'oversized', `${safe}.json`), body);
  writeJson(join(dir, name, 'oversized', `${safe}.sha256.json`), {
    key,
    bytes: Buffer.byteLength(body, 'utf8'),
    sha256: createHash('sha256').update(body).digest('hex'),
  });
}

export type CohortExportRequest<T> = {
  readonly name: string;
  readonly dir: string;
  readonly fetch: CohortFetch<T>;
  readonly shape: PageShape<T>;
  readonly bounds?: PageBounds;
  /** Raised after this many pages, for a test that needs the run to die mid-walk. */
  readonly failAfterPages?: number;
};

export async function exportCohort<T>(
  request: CohortExportRequest<T>,
): Promise<CohortExportResult> {
  const { name, dir, fetch, shape } = request;
  const bounds = request.bounds ?? COHORT_PAGE_BOUNDS;
  mkdirSync(join(dir, name, 'oversized'), { recursive: true });

  let progress = readProgress(dir, name);
  let pages = 0;

  for (;;) {
    if (request.failAfterPages !== undefined && pages >= request.failAfterPages) {
      throw new Error(`cohort export ${name} interrupted after ${String(pages)} pages`);
    }
    const fetched = await fetch(progress.cursor, bounds.maxRows);
    if (fetched.length === 0) {
      break;
    }
    const page = boundPage(fetched, shape, bounds);
    const index = String(pages).padStart(5, '0');
    writeJson(join(dir, name, `${PAGE_PREFIX}${index}.json`), {
      cursor: progress.cursor ?? null,
      bytes: page.bytes,
      rows: page.rows,
    });

    progress = advanceProgress(progress, page, shape);
    writeJson(progressPath(dir, name), progress);

    for (const member of page.oversized) {
      const row = fetched.find((candidate) => shape.key(candidate) === member.key);
      if (row === undefined) {
        continue;
      }
      streamOversized(dir, name, member.key, row);
      progress = recordOversizedExport(progress, member.key);
      writeJson(progressPath(dir, name), progress);
    }

    pages += 1;
    if (page.nextCursor === undefined) {
      break;
    }
  }

  // Written whatever the walk found. A cohort that held nothing was still walked, and a
  // directory with no record cannot say whether it was.
  writeJson(progressPath(dir, name), progress);

  const verdict = exportIsComplete(progress, progress.accounted);
  return {
    name,
    pages,
    members: progress.accounted,
    oversized: (progress.pendingOversized ?? []).map((member) => member.key),
    complete: verdict.complete && (progress.pendingOversized ?? []).length === 0,
    missing: verdict.missing,
    duplicated: verdict.duplicated,
  };
}
