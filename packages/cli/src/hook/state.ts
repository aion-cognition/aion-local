import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * One file per Claude session, holding the transcript cursor and the tool records buffered
 * since the last flush. State is a convenience, never a dependency: a missing or corrupt file
 * means the next read starts from the transcript's tail instead of failing.
 */

export const HOOK_STATE_DIR_NAME = 'hook-state';

export type BufferedTool = {
  readonly tool: string;
  readonly input: string;
  readonly output: string;
  readonly status: string;
  readonly occurredAt: string;
};

export type HookState = {
  /** Absent until the first flush, which is what sends the next read to the tail. */
  readonly offset: number | undefined;
  readonly lastFlushAt: string | undefined;
  /**
   * Names the file the offset was measured in, so a transcript rewritten in place is read from
   * its tail rather than from bytes that no longer exist. Only the harnesses that rewrite one
   * ever set it.
   */
  readonly fingerprint: string | undefined;
  readonly tools: readonly BufferedTool[];
};

export const EMPTY_STATE: HookState = {
  offset: undefined,
  lastFlushAt: undefined,
  fingerprint: undefined,
  tools: [],
};

export function defaultStateDir(): string {
  return join(homedir(), '.aion', HOOK_STATE_DIR_NAME);
}

/** A session id reaches this from stdin, so it never becomes a path of its own. */
function stateFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return `${safe === '' ? 'unknown' : safe}.json`;
}

export function stateFilePath(dir: string, sessionId: string): string {
  return join(dir, stateFileName(sessionId));
}

function toBufferedTool(value: unknown): BufferedTool | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.tool !== 'string' || record.tool === '') {
    return undefined;
  }
  return {
    tool: record.tool,
    input: typeof record.input === 'string' ? record.input : '',
    output: typeof record.output === 'string' ? record.output : '',
    status: typeof record.status === 'string' ? record.status : 'ok',
    occurredAt: typeof record.occurredAt === 'string' ? record.occurredAt : '',
  };
}

export function readHookState(dir: string, sessionId: string): HookState {
  let raw: string;
  try {
    raw = readFileSync(stateFilePath(dir, sessionId), 'utf8');
  } catch {
    return EMPTY_STATE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_STATE;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return EMPTY_STATE;
  }
  const record = parsed as Record<string, unknown>;
  const offset =
    typeof record.offset === 'number' && Number.isInteger(record.offset) && record.offset >= 0
      ? record.offset
      : undefined;
  const tools = Array.isArray(record.tools)
    ? record.tools.map(toBufferedTool).filter((tool): tool is BufferedTool => tool !== undefined)
    : [];
  return {
    offset,
    lastFlushAt: typeof record.lastFlushAt === 'string' ? record.lastFlushAt : undefined,
    fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : undefined,
    tools,
  };
}

/** Write failures are swallowed for the same reason read failures are: state is a cursor, not the work. */
export function writeHookState(dir: string, sessionId: string, state: HookState): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(stateFilePath(dir, sessionId), `${JSON.stringify(state)}\n`, 'utf8');
  } catch {
    // A cursor that cannot be written costs one re-read of the same window, never the turn.
  }
}

export function dropHookState(dir: string, sessionId: string): void {
  try {
    rmSync(stateFilePath(dir, sessionId), { force: true });
  } catch {
    // The file outlives the session it named and is overwritten if that id ever returns.
  }
}
