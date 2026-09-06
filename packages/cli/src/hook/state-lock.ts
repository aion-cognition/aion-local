import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';

import { HOOK_TIMEOUT_MS } from './options.js';
import { stateFilePath } from './state.js';

/**
 * One lock file per session, beside the state file it guards. A stateful handler reads the
 * state, awaits a round trip, and writes back an advanced cursor with an emptied tool buffer,
 * so a second fire that appended during that await would be overwritten. The harness runs
 * every fire as its own process, which is why this is a file and not a mutex.
 *
 * Nothing here throws. A lock that cannot be taken costs the fire its observation, which the
 * caller reports, and never the turn.
 */

const LOCK_SUFFIX = '.lock';

const POLL_MS = 10;

/** Three times the ceiling one fire has. A lock older than that belongs to a process that is gone. */
const STALE_MS = HOOK_TIMEOUT_MS * 3;

type LockOwner = {
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  readonly at: number;
};

/** What a fire that had to wait, recover, or give up leaves for its trace line. */
export type LockReport = {
  readonly waitedMs: number;
  readonly acquired: boolean;
  readonly recovered: boolean;
};

let pending: LockReport | undefined;

/** Read once per fire, by the trace that follows the handler. */
export function takeLockReport(): LockReport | undefined {
  const report = pending;
  pending = undefined;
  return report;
}

export function lockFilePath(dir: string, sessionId: string): string {
  return `${stateFilePath(dir, sessionId)}${LOCK_SUFFIX}`;
}

/**
 * Half of one fire's ceiling. A waiter that spent the whole budget here would have nothing
 * left for the round trip it took the lock to make, so a flush that runs longer than this is
 * left to finish alone.
 */
function budgetMs(fireBudgetMs: number): number {
  return Math.max(POLL_MS, Math.floor(fireBudgetMs / 2));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** O_EXCL, so two processes racing for the same session cannot both come back holding it. */
function claim(path: string, token: string): LockOwner | undefined {
  const owner: LockOwner = { token, pid: process.pid, host: hostname(), at: Date.now() };
  let handle: number;
  try {
    handle = openSync(path, 'wx');
  } catch {
    return undefined;
  }
  try {
    writeFileSync(handle, JSON.stringify(owner), 'utf8');
  } catch {
    // The file exists and names nobody, which the staleness rules below then clear.
  } finally {
    closeSync(handle);
  }
  return owner;
}

function readOwner(path: string): LockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.token !== 'string' || typeof record.pid !== 'number') {
    return undefined;
  }
  return {
    token: record.token,
    pid: record.pid,
    host: typeof record.host === 'string' ? record.host : '',
    at: typeof record.at === 'number' ? record.at : 0,
  };
}

/**
 * A lock file outlives the process that made it: a killed fire never releases. Age answers for
 * an owner on any machine, and on this one a pid that no longer exists answers immediately, so
 * the next fire recovers rather than waiting the age out. Signal 0 tests existence without
 * delivering anything, and EPERM means the process is there under another user.
 */
function abandoned(owner: LockOwner, now: number): boolean {
  if (now - owner.at > STALE_MS) {
    return true;
  }
  if (owner.host !== hostname()) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Only the exact record judged abandoned is removed, so a lock a live fire took in the
 * meantime survives. The create that follows is what decides who owns it next.
 */
function discard(path: string, seen: LockOwner): boolean {
  if (readOwner(path)?.token !== seen.token) {
    return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    // Another waiter got there first, which is the same outcome.
    return false;
  }
}

/**
 * A lock file naming nobody is normal for the moment between one process creating it and
 * writing its record, so age is the only thing that separates that from a truncated file no
 * release will ever match.
 */
function discardUnreadable(path: string, now: number): boolean {
  try {
    if (now - statSync(path).mtimeMs <= STALE_MS) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Releasing is scoped to the token this fire wrote: a lock already recovered by someone else stays theirs. */
function release(path: string, owner: LockOwner): void {
  if (readOwner(path)?.token !== owner.token) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // The next claim overwrites the record anyway, and staleness clears a file nobody can remove.
  }
}

/**
 * Runs `critical` with the session's state file to itself, or returns undefined when the wait
 * ran out. Every read-modify-write of that file belongs in here, cleanup included: a drop that
 * lands between another fire's read and its write resurrects what it deleted.
 */
export async function withHookStateLock<T>(
  dir: string,
  sessionId: string,
  fireBudgetMs: number,
  critical: () => Promise<T>,
): Promise<T | undefined> {
  const path = lockFilePath(dir, sessionId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // A directory that cannot be made holds no state to serialize, and claiming below fails too.
  }
  const started = Date.now();
  const deadline = started + budgetMs(fireBudgetMs);
  const token = randomUUID();
  let recovered = false;
  for (;;) {
    const owner = claim(path, token);
    if (owner !== undefined) {
      // An uncontended take says nothing worth a line: only a fire that queued behind another
      // one or cleared a lock nobody released reports.
      const waitedMs = Date.now() - started;
      if (waitedMs >= POLL_MS || recovered) {
        pending = { waitedMs, acquired: true, recovered };
      }
      try {
        return await critical();
      } finally {
        release(path, owner);
      }
    }
    const held = readOwner(path);
    if (held === undefined) {
      recovered = discardUnreadable(path, Date.now()) || recovered;
    } else if (abandoned(held, Date.now())) {
      recovered = discard(path, held) || recovered;
    }
    if (Date.now() >= deadline) {
      pending = { waitedMs: Date.now() - started, acquired: false, recovered };
      return undefined;
    }
    await delay(POLL_MS);
  }
}
