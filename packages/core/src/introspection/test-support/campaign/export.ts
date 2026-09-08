import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  advanceProgress,
  boundPage,
  COHORT_PAGE_BOUNDS,
  EMPTY_PROGRESS,
  exportIsComplete,
  recordOversizedExport,
  type ExportProgress,
  type OversizedMember,
  type PageBounds,
  type PageShape,
} from '../../domain/campaign-paging.js';

/**
 * A cohort export that survives being killed.
 *
 * Each page is written under an identity nothing later reuses, then the record that says it was
 * written, carrying the cursor the next fetch resumes from. A resumed run continues the page
 * numbering it found rather than starting at zero, because starting at zero writes over the
 * pages the first run persisted and leaves a membership list describing files that are gone.
 *
 * A member too large for a page is exported only once its own bytes and their digest are on
 * disk. A run killed between the two restarts owing that transfer, and the resume services it
 * before it fetches anything, since the cursor has already moved past the row.
 *
 * Completion is checked against the files on disk, never against the accounting list compared
 * with itself: a list agreeing with itself cannot notice a page nobody wrote.
 *
 * Everything is written under a directory the caller names, never back into a store.
 */

const PROGRESS_FILE = 'progress.json';
const PAGE_PREFIX = 'page-';
const OVERSIZED_DIR = 'oversized';

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

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The record, or the fact that there is none.
 *
 * An absent record is a fresh export. A record that will not parse is a record: something wrote
 * it and this run cannot read it, so continuing would overwrite pages it cannot account for.
 * The two are different answers and the caller gets both.
 */
export type ProgressRead =
  | { readonly status: 'absent' }
  | { readonly status: 'read'; readonly progress: ExportProgress }
  | { readonly status: 'unreadable'; readonly detail: string };

export function readProgress(dir: string, name: string): ProgressRead {
  const path = progressPath(dir, name);
  if (!existsSync(path)) {
    return { status: 'absent' };
  }
  try {
    return { status: 'read', progress: JSON.parse(readFileSync(path, 'utf8')) as ExportProgress };
  } catch (err) {
    return { status: 'unreadable', detail: String(err) };
  }
}

/** Written beside and renamed over, so a reader never sees half a record. */
function writeJson(path: string, value: unknown): void {
  const staging = `${path}.writing`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staging, path);
}

/** Content first, then its digest, then the record that says the transfer happened. */
function streamOversized(dir: string, name: string, key: string, row: unknown): void {
  const body = `${JSON.stringify(row, null, 2)}\n`;
  const safe = safeName(key);
  writeJson(join(dir, name, OVERSIZED_DIR, `${safe}.json`), row);
  writeJson(join(dir, name, OVERSIZED_DIR, `${safe}.sha256.json`), {
    key,
    bytes: Buffer.byteLength(body, 'utf8'),
    sha256: createHash('sha256').update(body).digest('hex'),
  });
}

/** Page files already on disk, so a resumed run numbers its own pages after them. */
function persistedPageFiles(dir: string, name: string): readonly string[] {
  try {
    return readdirSync(join(dir, name))
      .filter((file) => file.startsWith(PAGE_PREFIX) && file.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

/** Every member the persisted pages and completed transfers actually hold. */
export function persistedMembers(dir: string, name: string): readonly string[] {
  const members: string[] = [];
  for (const file of persistedPageFiles(dir, name)) {
    const page = JSON.parse(readFileSync(join(dir, name, file), 'utf8')) as {
      rows: { id?: string }[];
      keys?: string[];
    };
    members.push(...(page.keys ?? page.rows.map((row) => row.id ?? '')));
  }
  for (const key of completedTransfers(dir, name)) {
    members.push(key);
  }
  return members;
}

/** The oversized members whose digest file is on disk, which is what makes a transfer done. */
export function completedTransfers(dir: string, name: string): readonly string[] {
  try {
    return readdirSync(join(dir, name, OVERSIZED_DIR))
      .filter((file) => file.endsWith('.sha256.json'))
      .map(
        (file) =>
          (
            JSON.parse(readFileSync(join(dir, name, OVERSIZED_DIR, file), 'utf8')) as {
              key: string;
            }
          ).key,
      )
      .sort();
  } catch {
    return [];
  }
}

/** One transferred payload, read back from the bytes its digest covers. */
export function readTransferred(dir: string, name: string, key: string): unknown {
  return JSON.parse(readFileSync(join(dir, name, OVERSIZED_DIR, `${safeName(key)}.json`), 'utf8'));
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

/**
 * Services a transfer the previous run owed. The cursor has already moved past the row, so the
 * fetch will never offer it again; the only way to finish it is to ask for it by its own key.
 */
async function recoverPending<T>(
  request: CohortExportRequest<T>,
  progress: ExportProgress,
): Promise<ExportProgress> {
  const { name, dir, fetch, shape } = request;
  const done = new Set(completedTransfers(dir, name));
  let recovered = progress;
  for (const member of progress.pendingOversized ?? []) {
    if (done.has(member.key)) {
      recovered = recordOversizedExport(recovered, member.key);
      writeJson(progressPath(dir, name), recovered);
      continue;
    }
    const reachable = await fetch(priorKey(member.key), request.bounds?.maxRows ?? 200);
    const row = reachable.find((candidate) => shape.key(candidate) === member.key);
    if (row === undefined) {
      continue;
    }
    streamOversized(dir, name, member.key, row);
    recovered = recordOversizedExport(recovered, member.key);
    writeJson(progressPath(dir, name), recovered);
  }
  return recovered;
}

/**
 * The cursor that puts one key back in reach. Keyset reads answer with everything after the
 * cursor, so the key just before this one is what asks for this one.
 */
function priorKey(key: string): string | undefined {
  const last = key.slice(-1);
  if (last === '') {
    return undefined;
  }
  const previous = String.fromCharCode(last.charCodeAt(0) - 1);
  return `${key.slice(0, -1)}${previous}`;
}

export async function exportCohort<T>(
  request: CohortExportRequest<T>,
): Promise<CohortExportResult> {
  const { name, dir, fetch, shape } = request;
  const bounds = request.bounds ?? COHORT_PAGE_BOUNDS;
  mkdirSync(join(dir, name, OVERSIZED_DIR), { recursive: true });

  const record = readProgress(dir, name);
  if (record.status === 'unreadable') {
    throw new Error(
      `cohort export ${name} found a progress record it cannot read: ${record.detail}`,
    );
  }
  let progress = record.status === 'read' ? record.progress : EMPTY_PROGRESS;
  // Continue the numbering the previous run left, or a resumed page overwrites its first page.
  let pages = persistedPageFiles(dir, name).length;

  progress = await recoverPending(request, progress);

  const written = pages;
  for (;;) {
    if (request.failAfterPages !== undefined && pages - written >= request.failAfterPages) {
      throw new Error(`cohort export ${name} interrupted after ${String(pages - written)} pages`);
    }
    const fetched = await fetch(progress.cursor, bounds.maxRows);
    if (fetched.length === 0) {
      break;
    }
    const page = boundPage(fetched, shape, bounds);
    writeJson(join(dir, name, `${PAGE_PREFIX}${String(pages).padStart(5, '0')}.json`), {
      cursor: progress.cursor ?? null,
      bytes: page.bytes,
      keys: page.rows.map(shape.key),
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

  // Against the files, not against the list. A list compared with itself agrees every time.
  const onDisk = persistedMembers(dir, name);
  const verdict = exportIsComplete(progress, onDisk);
  const onDiskKeys = new Set(onDisk);
  // Both directions: a member the record claims that no file holds, and a member a file holds
  // that the record never accounted for.
  const unwritten = progress.accounted.filter((key) => !onDiskKeys.has(key));
  const owed: readonly OversizedMember[] = progress.pendingOversized ?? [];
  const missing = [...new Set([...verdict.missing, ...unwritten])].sort();
  return {
    name,
    pages,
    members: onDisk,
    oversized: owed.map((member) => member.key),
    complete: missing.length === 0 && verdict.duplicated.length === 0 && owed.length === 0,
    missing,
    duplicated: verdict.duplicated,
  };
}
