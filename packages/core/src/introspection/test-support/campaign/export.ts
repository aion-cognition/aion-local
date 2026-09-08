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

function occurrences(keys: readonly string[]): ReadonlyMap<string, number> {
  const counted = new Map<string, number>();
  for (const key of keys) {
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  return counted;
}

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

/**
 * One past the highest index on disk, never the file count. A directory missing `page-00001`
 * has two files and a highest index of two, and numbering from the count would write over
 * `page-00002`.
 */
function nextPageIndex(dir: string, name: string): number {
  let highest = -1;
  for (const file of persistedPageFiles(dir, name)) {
    const index = Number.parseInt(file.slice(PAGE_PREFIX.length), 10);
    if (Number.isInteger(index)) {
      highest = Math.max(highest, index);
    }
  }
  return highest + 1;
}

/** The keys one persisted page holds, in the order it holds them. */
function pageKeys(dir: string, name: string, file: string): readonly string[] {
  const page = JSON.parse(readFileSync(join(dir, name, file), 'utf8')) as {
    rows: { id?: string }[];
    keys?: string[];
  };
  return page.keys ?? page.rows.map((row) => row.id ?? '');
}

/** Every member the persisted pages and completed transfers actually hold. */
export function persistedMembers(dir: string, name: string): readonly string[] {
  const members: string[] = [];
  for (const file of persistedPageFiles(dir, name)) {
    members.push(...pageKeys(dir, name, file));
  }
  for (const key of completedTransfers(dir, name)) {
    members.push(key);
  }
  return members;
}

type TransferReceipt = {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
};

/**
 * The payload a receipt covers, if the bytes on disk are the bytes it covers.
 *
 * A receipt beside a payload is not a verified transfer: the payload can be gone, truncated or
 * rewritten while the receipt still sits there claiming otherwise. So the bytes are read, their
 * length and digest are recomputed, and the key on the receipt has to be the key asked for.
 */
export function verifyTransfer(dir: string, name: string, key: string): string | undefined {
  let receipt: TransferReceipt;
  try {
    receipt = JSON.parse(
      readFileSync(join(dir, name, OVERSIZED_DIR, `${safeName(key)}.sha256.json`), 'utf8'),
    ) as TransferReceipt;
  } catch {
    return undefined;
  }
  if (receipt.key !== key) {
    return undefined;
  }
  let body: string;
  try {
    body = readFileSync(join(dir, name, OVERSIZED_DIR, `${safeName(key)}.json`), 'utf8');
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(body, 'utf8') !== receipt.bytes) {
    return undefined;
  }
  if (createHash('sha256').update(body).digest('hex') !== receipt.sha256) {
    return undefined;
  }
  return body;
}

/** The oversized members whose bytes verify against their receipt. Nothing else counts as done. */
export function completedTransfers(dir: string, name: string): readonly string[] {
  let receipts: readonly string[];
  try {
    receipts = readdirSync(join(dir, name, OVERSIZED_DIR)).filter((file) =>
      file.endsWith('.sha256.json'),
    );
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const file of receipts) {
    try {
      const receipt = JSON.parse(
        readFileSync(join(dir, name, OVERSIZED_DIR, file), 'utf8'),
      ) as TransferReceipt;
      if (verifyTransfer(dir, name, receipt.key) !== undefined) {
        keys.push(receipt.key);
      }
    } catch {
      // A receipt nothing can read covers nothing, so it names no completed transfer.
    }
  }
  return keys.sort();
}

export class TransferUnverified extends Error {
  constructor(name: string, key: string) {
    super(`cohort export ${name} holds no verified transfer for ${key}`);
    this.name = 'TransferUnverified';
  }
}

/** One transferred payload, read back from the bytes its digest covers, or a refusal. */
export function readTransferred(dir: string, name: string, key: string): unknown {
  const body = verifyTransfer(dir, name, key);
  if (body === undefined) {
    throw new TransferUnverified(name, key);
  }
  return JSON.parse(body);
}

export type CohortExportRequest<T> = {
  readonly name: string;
  readonly dir: string;
  readonly fetch: CohortFetch<T>;
  /**
   * One member by its own key, for finishing a transfer the previous run owed. The cursor has
   * already moved past that row, so no keyset read will offer it again, and there is no
   * ordering trick that reaches one key from another: a cohort key is an arbitrary string.
   * Absent when the caller has no direct read, and then the walk finds it by starting over.
   */
  readonly fetchKey?: (key: string) => Promise<readonly T[]> | readonly T[];
  readonly shape: PageShape<T>;
  readonly bounds?: PageBounds;
  /** Raised after this many pages, for a test that needs the run to die mid-walk. */
  readonly failAfterPages?: number;
};

/**
 * The one row a key names.
 *
 * A direct read answers it outright. Without one the walk starts at the beginning and pages
 * forward until the key appears, which is exact rather than a guess: it compares keys instead
 * of assuming an ordering trick reaches one from another.
 */
async function memberByKey<T>(
  request: CohortExportRequest<T>,
  key: string,
): Promise<T | undefined> {
  const { fetch, fetchKey, shape } = request;
  if (fetchKey !== undefined) {
    return (await fetchKey(key)).find((candidate) => shape.key(candidate) === key);
  }
  const limit = request.bounds?.maxRows ?? COHORT_PAGE_BOUNDS.maxRows;
  let cursor: string | undefined;
  for (;;) {
    const page = await fetch(cursor, limit);
    if (page.length === 0) {
      return undefined;
    }
    const found = page.find((candidate) => shape.key(candidate) === key);
    if (found !== undefined) {
      return found;
    }
    const last = page[page.length - 1];
    if (last === undefined) {
      return undefined;
    }
    cursor = shape.key(last);
  }
}

/**
 * Services a transfer the previous run owed. A key whose bytes already verify is simply marked
 * done; one whose bytes are gone or no longer match is streamed again.
 */
async function recoverPending<T>(
  request: CohortExportRequest<T>,
  progress: ExportProgress,
): Promise<ExportProgress> {
  const { name, dir } = request;
  let recovered = progress;
  for (const member of progress.pendingOversized ?? []) {
    if (verifyTransfer(dir, name, member.key) !== undefined) {
      recovered = recordOversizedExport(recovered, member.key);
      writeJson(progressPath(dir, name), recovered);
      continue;
    }
    const row = await memberByKey(request, member.key);
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
 * Adopts a page the previous run wrote and did not live to record.
 *
 * Writing the page before the record is what makes the page durable; the cost is that a run
 * killed between the two leaves work nobody accounted for. Replaying it would write the same
 * members a second time under a new page, so the members are adopted from the file that
 * already holds them and the cursor moves to the last of them.
 */
function reconcileUnaccounted(dir: string, name: string, progress: ExportProgress): ExportProgress {
  const accounted = new Set(progress.accounted);
  const adopted: string[] = [];
  let { cursor } = progress;
  for (const file of persistedPageFiles(dir, name)) {
    for (const key of pageKeys(dir, name, file)) {
      if (!accounted.has(key)) {
        adopted.push(key);
        accounted.add(key);
      }
      cursor = cursor === undefined || key > cursor ? key : cursor;
    }
  }
  if (adopted.length === 0) {
    return progress;
  }
  const reconciled: ExportProgress = {
    accounted: [...progress.accounted, ...adopted],
    pendingOversized: progress.pendingOversized ?? [],
    ...(cursor === undefined ? {} : { cursor }),
  };
  writeJson(progressPath(dir, name), reconciled);
  return reconciled;
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
  // One past the highest index on disk, so a resumed page never lands on a name already taken.
  let pages = nextPageIndex(dir, name);

  progress = reconcileUnaccounted(dir, name, progress);
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

  // Against the files, not against the list. A list compared with itself agrees every time, and
  // counting occurrences on both sides is what catches one member written into two pages.
  const onDisk = persistedMembers(dir, name);
  const held = occurrences(onDisk);
  const claimed = occurrences(progress.accounted);
  const keys = [...new Set([...held.keys(), ...claimed.keys()])].sort();
  const missing = keys.filter((key) => (held.get(key) ?? 0) < (claimed.get(key) ?? 0));
  const duplicated = keys.filter(
    (key) => (held.get(key) ?? 0) > 1 || (held.get(key) ?? 0) > (claimed.get(key) ?? 0),
  );
  const owed: readonly OversizedMember[] = progress.pendingOversized ?? [];
  return {
    name,
    pages,
    members: onDisk,
    oversized: owed.map((member) => member.key),
    complete: missing.length === 0 && duplicated.length === 0 && owed.length === 0,
    missing,
    duplicated,
  };
}
