import { fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FetchImpl } from './mcp.js';
import { HOOK_TIMEOUT_MS, type HookOptions } from './options.js';
import { runHook } from './run.js';
import { readHookState, stateFilePath, writeHookState } from './state.js';

/**
 * Two hook fires for one session are two processes: the harness runs each one as its own
 * command, and both read the session's state file, act, and write it back. The window between
 * the read and the write is a round trip wide on the flush paths, so these fires are real
 * children rather than interleaved handlers in one process.
 */

const SESSION_ID = 'claude-session-concurrent';
const NOW = '2026-09-06T04:00:00.000Z';

const FIXTURE = fileURLToPath(new URL('./hook-fire.fixture.mjs', import.meta.url));

const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'the fix is a per-table split' }] },
  timestamp: '2026-09-06T03:00:00.000Z',
});

const BUFFERED_TOOL = {
  tool: 'mcp__slack__conversations_history',
  input: '{"channel":"C123"}',
  output: '{"messages":["the deploy is blocked"]}',
  status: 'ok',
  occurredAt: '2026-09-06T03:30:00.000Z',
};

const APPENDED_TOOL_INPUT = {
  tool_name: 'mcp__linear__list_issues',
  tool_input: { team: 'POPS' },
  tool_response: { issues: ['the cursor moved'] },
};

type ToolCall = { readonly name: string; readonly arguments: Record<string, unknown> };

type FireResult = {
  readonly exit: number;
  readonly calls: readonly ToolCall[];
  readonly error?: string;
};

type FireConfig = {
  readonly event: string;
  readonly input: Record<string, unknown>;
  readonly stateDir: string;
  readonly timeoutMs?: number;
  readonly holdMarker?: string;
  readonly releaseMarker?: string;
};

type Fire = {
  readonly ready: Promise<void>;
  readonly result: Promise<FireResult>;
  readonly gone: Promise<void>;
  readonly go: () => void;
  readonly kill: () => void;
};

function spawnFire(config: FireConfig): Fire {
  const child = fork(FIXTURE, [JSON.stringify({ ...config, now: NOW })], {
    execArgv: ['--experimental-strip-types', '--no-warnings'],
  });

  const failed = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`hook fire exited with code ${String(code)}`));
      }
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', (message: unknown) => {
      if (message === 'ready') {
        resolve();
      } else {
        reject(new Error(`unexpected message before ready: ${String(message)}`));
      }
    });
  });
  const result = new Promise<FireResult>((resolve) => {
    child.on('message', (message: unknown) => {
      if (message !== 'ready') {
        resolve(message as FireResult);
      }
    });
  });

  const gone = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });

  return {
    ready: Promise.race([ready, failed]),
    result: Promise.race([result, failed]),
    gone,
    go: (): void => {
      child.send('go');
    },
    kill: (): void => {
      child.kill('SIGKILL');
    },
  };
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`nothing wrote ${path} within ${String(timeoutMs)}ms`);
    }
    await delay(10);
  }
}

function executionsIn(calls: readonly ToolCall[]): readonly Record<string, unknown>[] {
  return calls.flatMap(
    (call) => (call.arguments.tool_executions ?? []) as Record<string, unknown>[],
  );
}

function traceEntries(stateDir: string): readonly Record<string, unknown>[] {
  const raw = readFileSync(join(stateDir, 'hooks.log'), 'utf8').trim();
  return raw === ''
    ? []
    : raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('two hook fires against one session state', () => {
  let dir: string;
  let stateDir: string;
  let transcriptPath: string;
  let holdMarker: string;
  let releaseMarker: string;
  let sleeper: ChildProcess | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-hook-concurrency-'));
    stateDir = join(dir, 'state');
    transcriptPath = join(dir, 'transcript.jsonl');
    holdMarker = join(dir, 'flush-started');
    releaseMarker = join(dir, 'flush-release');
    writeFileSync(transcriptPath, `${ASSISTANT_LINE}\n`);
    writeHookState(stateDir, SESSION_ID, {
      offset: undefined,
      lastFlushAt: undefined,
      fingerprint: undefined,
      tools: [BUFFERED_TOOL],
    });
  });

  afterEach(() => {
    sleeper?.kill('SIGKILL');
    sleeper = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function options(event: HookOptions['event'], fetchImpl: FetchImpl): HookOptions {
    return {
      event,
      harness: 'claude',
      stopMode: 'push',
      minChars: 40,
      keyState: 'present',
      settingsPath: join(dir, 'settings.json'),
      stateDir,
      endpoint: 'http://127.0.0.1:8765/mcp',
      fetchImpl,
      timeoutMs: HOOK_TIMEOUT_MS,
      now: (): Date => new Date(NOW),
      stdout: (): void => undefined,
      stderr: (): void => undefined,
    };
  }

  /** Answers initialize, then fails the tool call the way an unhealthy service does. */
  const failingTransport: FetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    if (body?.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'transport-1' },
      });
    }
    if (body?.method === 'tools/call') {
      return new Response('the service is down', { status: 500 });
    }
    return new Response(null, { status: 202 });
  }) as unknown as FetchImpl;

  function lockPath(): string {
    return `${stateFilePath(stateDir, SESSION_ID)}.lock`;
  }

  /** The record a holder writes, so a test can stand one up without a fire behind it. */
  function plantLock(pid: number, at: number): void {
    writeFileSync(
      lockPath(),
      JSON.stringify({ token: 'planted-owner', pid, host: hostname(), at }),
      'utf8',
    );
  }

  it('keeps a tool buffered while a flush is in flight', async () => {
    const flush = spawnFire({
      event: 'pre-compact',
      input: { session_id: SESSION_ID, transcript_path: transcriptPath },
      stateDir,
      holdMarker,
      releaseMarker,
    });
    await flush.ready;
    flush.go();
    await waitForFile(holdMarker, 15_000);

    const append = spawnFire({
      event: 'post-tool-use',
      input: { session_id: SESSION_ID, ...APPENDED_TOOL_INPUT },
      stateDir,
    });
    await append.ready;
    append.go();
    await delay(300);
    writeFileSync(releaseMarker, '');
    const [flushed, appended] = await Promise.all([flush.result, append.result]);

    expect(flushed.exit).toBe(0);
    expect(appended.exit).toBe(0);
    expect(executionsIn(flushed.calls)).toHaveLength(1);
    expect(readHookState(stateDir, SESSION_ID).tools.map((tool) => tool.tool)).toEqual([
      APPENDED_TOOL_INPUT.tool_name,
    ]);
  }, 60_000);

  it('sends one flush of a window two fires reach together', async () => {
    const held = spawnFire({
      event: 'pre-compact',
      input: { session_id: SESSION_ID, transcript_path: transcriptPath },
      stateDir,
      holdMarker,
      releaseMarker,
    });
    await held.ready;
    held.go();
    await waitForFile(holdMarker, 15_000);

    const second = spawnFire({
      event: 'pre-compact',
      input: { session_id: SESSION_ID, transcript_path: transcriptPath },
      stateDir,
    });
    await second.ready;
    second.go();
    await delay(300);
    writeFileSync(releaseMarker, '');
    const [first, follower] = await Promise.all([held.result, second.result]);

    expect(executionsIn([...first.calls, ...follower.calls])).toHaveLength(1);
    expect(follower.calls).toEqual([]);
  }, 60_000);

  it('keeps a record appended while the session is being cleaned up', async () => {
    const ending = spawnFire({
      event: 'session-end',
      input: { session_id: SESSION_ID, transcript_path: transcriptPath },
      stateDir,
      holdMarker,
      releaseMarker,
    });
    await ending.ready;
    ending.go();
    await waitForFile(holdMarker, 15_000);

    const append = spawnFire({
      event: 'post-tool-use',
      input: { session_id: SESSION_ID, ...APPENDED_TOOL_INPUT },
      stateDir,
    });
    await append.ready;
    append.go();
    await delay(300);
    writeFileSync(releaseMarker, '');
    await Promise.all([ending.result, append.result]);

    expect(readHookState(stateDir, SESSION_ID).tools.map((tool) => tool.tool)).toEqual([
      APPENDED_TOOL_INPUT.tool_name,
    ]);
  }, 60_000);

  it('leaves the cursor and the buffer alone when the flush itself fails', async () => {
    await expect(
      runHook(
        { session_id: SESSION_ID, transcript_path: transcriptPath },
        options('pre-compact', failingTransport),
      ),
    ).resolves.toBe(0);

    const state = readHookState(stateDir, SESSION_ID);
    expect(state.tools).toHaveLength(1);
    expect(state.offset).toBeUndefined();
    expect(traceEntries(stateDir).at(-1)?.error).toContain('500');
  });

  it('takes over from a fire that died holding the lock', async () => {
    const flush = spawnFire({
      event: 'pre-compact',
      input: { session_id: SESSION_ID, transcript_path: transcriptPath },
      stateDir,
      holdMarker,
      releaseMarker,
    });
    await flush.ready;
    flush.go();
    await waitForFile(holdMarker, 15_000);
    flush.kill();
    await flush.gone;

    await expect(
      runHook(
        { session_id: SESSION_ID, ...APPENDED_TOOL_INPUT },
        options('post-tool-use', failingTransport),
      ),
    ).resolves.toBe(0);

    // The killed flush never advanced, so its window stands and the new record joins it.
    expect(readHookState(stateDir, SESSION_ID).tools).toHaveLength(2);
    expect(existsSync(lockPath())).toBe(false);
  }, 60_000);

  it('gives up rather than outwait a live owner, and traces what it dropped', async () => {
    sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 30000)']);
    plantLock(sleeper.pid ?? 1, Date.now());

    await expect(
      runHook(
        { session_id: SESSION_ID, ...APPENDED_TOOL_INPUT },
        { ...options('post-tool-use', failingTransport), timeoutMs: 300 },
      ),
    ).resolves.toBe(0);

    expect(readHookState(stateDir, SESSION_ID).tools).toHaveLength(1);
    expect(traceEntries(stateDir).at(-1)?.lock).toMatchObject({ acquired: false });
  });
});
