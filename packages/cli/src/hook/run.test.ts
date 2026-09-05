import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeyState } from './key-state.js';
import { mcpEndpoint, parseRpcBody, type FetchImpl } from './mcp.js';
import {
  HOOK_EVENTS,
  HOOK_TIMEOUT_MS,
  KEYLESS_NOTICE,
  STOP_INSTRUCTION,
  type HookOptions,
  type StopMode,
} from './options.js';
import { OBSERVATION_LIMIT } from './payload.js';
import { parseHookFlags, parseHookInput, runHook } from './run.js';
import { backupPath } from './settings-file.js';
import { describeAionHooks } from './settings.js';
import { readHookState, stateFilePath } from './state.js';

const SESSION_ID = 'claude-session-7';

const NOW = new Date('2026-08-30T04:00:00.000Z');

const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'the fix is a per-table split' }] },
  timestamp: '2026-08-30T03:00:00.000Z',
});

const USER_LINE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'why did the migration deadlock' },
  timestamp: '2026-08-30T02:59:00.000Z',
});

const POPULATED_PACK = {
  facts: [{ id: 'f1', content: 'the DDL takes locks in one transaction' }],
  rendered_text: '# Memory\n\n## Facts\n1. the DDL takes locks in one transaction',
};

const EMPTY_PACK = { rendered_text: '# Memory\n\nNo memories matched this query.' };

type RecordedCall = { readonly method: string; readonly body: Record<string, unknown> | undefined };

function transport(toolResult: unknown): { fetchImpl: FetchImpl; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, body });

    if (body?.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'transport-1' },
      });
    }
    if (body?.method === 'tools/call') {
      const frame = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: toolResult });
      return new Response(`event: message\ndata: ${frame}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(null, { status: 202 });
  });
  return { fetchImpl: impl as unknown as FetchImpl, calls };
}

function toolNamesIn(calls: readonly RecordedCall[]): readonly string[] {
  return calls
    .filter((call) => call.body?.method === 'tools/call')
    .map((call) => String((call.body?.params as Record<string, unknown>).name));
}

function toolArgsIn(calls: readonly RecordedCall[]): Record<string, unknown> {
  const call = calls.find((entry) => entry.body?.method === 'tools/call');
  const params = call?.body?.params as Record<string, unknown>;
  return params.arguments as Record<string, unknown>;
}

describe('hook events', () => {
  let dir: string;
  let transcriptPath: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-hook-'));
    transcriptPath = join(dir, 'transcript.jsonl');
    stdout = [];
    stderr = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  type Overrides = {
    readonly fetchImpl: FetchImpl;
    readonly stopMode?: StopMode;
    readonly minChars?: number;
    readonly keyState?: KeyState;
    readonly settingsPath?: string;
    readonly now?: () => Date;
  };

  function options(event: HookOptions['event'], overrides: Overrides): HookOptions {
    return {
      event,
      stopMode: overrides.stopMode ?? 'push',
      minChars: overrides.minChars ?? 40,
      keyState: overrides.keyState ?? 'present',
      // Under the temp directory whatever the case: no test may reach the real settings file.
      settingsPath: overrides.settingsPath ?? join(dir, 'home', '.claude', 'settings.json'),
      stateDir: join(dir, 'state'),
      endpoint: 'http://127.0.0.1:8765/mcp',
      fetchImpl: overrides.fetchImpl,
      timeoutMs: HOOK_TIMEOUT_MS,
      now: overrides.now ?? ((): Date => NOW),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    };
  }

  it('opens, notifies, calls, and deletes exactly once on session start', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: POPULATED_PACK });

    await expect(
      runHook({ session_id: SESSION_ID }, options('session-start', { fetchImpl })),
    ).resolves.toBe(0);

    expect(calls.map((call) => call.body?.method ?? call.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'DELETE',
    ]);
    expect(toolNamesIn(calls)).toEqual(['recall']);
  });

  it('passes the claude session id through as the tool argument', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: POPULATED_PACK });

    await runHook({ session_id: SESSION_ID }, options('session-start', { fetchImpl }));

    expect(toolArgsIn(calls)).toMatchObject({
      session_id: SESSION_ID,
      budget: { max_tokens: 2000 },
    });
  });

  it('emits the pack as SessionStart additional context', async () => {
    const { fetchImpl } = transport({ structuredContent: POPULATED_PACK });

    await runHook({ session_id: SESSION_ID }, options('session-start', { fetchImpl }));

    const emitted = JSON.parse(stdout[0] ?? '{}');
    expect(emitted.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(emitted.hookSpecificOutput.additionalContext).toContain('Aion memory');
    expect(emitted.hookSpecificOutput.additionalContext).toContain('the DDL takes locks');
  });

  it('says nothing at all when the pack holds no items', async () => {
    const { fetchImpl } = transport({ structuredContent: EMPTY_PACK });

    await expect(
      runHook({ session_id: SESSION_ID }, options('session-start', { fetchImpl })),
    ).resolves.toBe(0);
    expect(stdout).toEqual([]);
  });

  it('skips a prompt shorter than the minimum and never opens a session', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: POPULATED_PACK });

    await expect(
      runHook(
        { session_id: SESSION_ID, prompt: 'ok thanks' },
        options('prompt-submit', { fetchImpl }),
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual([]);
    expect(stdout).toEqual([]);
  });

  it('recalls on the prompt itself once it is long enough', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: POPULATED_PACK });
    const prompt = 'why did the v3.21.596 migration deadlock against read-only joins';

    await runHook(
      { session_id: SESSION_ID, prompt },
      options('prompt-submit', { fetchImpl, minChars: 40 }),
    );

    expect(toolArgsIn(calls)).toMatchObject({ query: prompt, budget: { max_tokens: 1200 } });
    expect(JSON.parse(stdout[0] ?? '{}').hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });

  it('honours a lowered min-chars threshold', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: POPULATED_PACK });

    await runHook(
      { session_id: SESSION_ID, prompt: 'short' },
      options('prompt-submit', { fetchImpl, minChars: 3 }),
    );

    expect(toolNamesIn(calls)).toEqual(['recall']);
  });

  it('pushes the turn as reflection on stop and advances the cursor', async () => {
    writeFileSync(transcriptPath, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
    const { fetchImpl, calls } = transport({ structuredContent: { episode_id: 'e1' } });

    await expect(
      runHook(
        { session_id: SESSION_ID, transcript_path: transcriptPath },
        options('stop', { fetchImpl }),
      ),
    ).resolves.toBe(0);

    expect(toolNamesIn(calls)).toEqual(['reflection']);
    const args = toolArgsIn(calls);
    expect(args.session_id).toBe(SESSION_ID);
    expect(args.turns).toEqual([
      {
        role: 'user',
        text: 'why did the migration deadlock',
        occurred_at: '2026-08-30T02:59:00.000Z',
      },
      {
        role: 'assistant',
        text: 'the fix is a per-table split',
        occurred_at: '2026-08-30T03:00:00.000Z',
      },
    ]);

    const state = readHookState(join(dir, 'state'), SESSION_ID);
    expect(state.offset).toBe(Buffer.byteLength(`${USER_LINE}\n${ASSISTANT_LINE}\n`));
  });

  it.each(['pre-compact', 'stop', 'subagent-stop', 'session-end'] as const)(
    'carries the origin channel and the %s event name on that push',
    async (event) => {
      writeFileSync(transcriptPath, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
      const { fetchImpl, calls } = transport({ structuredContent: { episode_id: 'e1' } });

      await runHook(
        { session_id: SESSION_ID, transcript_path: transcriptPath },
        options(event, { fetchImpl }),
      );

      expect(toolArgsIn(calls).origin).toEqual({ channel: 'hook', event });
    },
  );

  it('pushes the subagent synthesis as an observation and leaves the cursor alone', async () => {
    writeFileSync(transcriptPath, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
    const { fetchImpl, calls } = transport({ structuredContent: { episode_id: 'e1' } });

    await expect(
      runHook(
        {
          session_id: SESSION_ID,
          transcript_path: transcriptPath,
          last_assistant_message: 'the sweep found two oracle sites',
          agent_type: 'Explore',
        },
        options('subagent-stop', { fetchImpl }),
      ),
    ).resolves.toBe(0);

    expect(toolNamesIn(calls)).toEqual(['reflection']);
    const args = toolArgsIn(calls);
    expect(args.observations).toEqual(['[Explore] the sweep found two oracle sites']);
    expect(args.turns).toBeUndefined();
    expect(args.session_id).toBe(SESSION_ID);
    expect(args.origin).toEqual({ channel: 'hook', event: 'subagent-stop' });
    expect(existsSync(stateFilePath(join(dir, 'state'), SESSION_ID))).toBe(false);
  });

  it('drops the provenance prefix when the payload names no agent type', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: { episode_id: 'e1' } });

    await runHook(
      { session_id: SESSION_ID, last_assistant_message: 'no agent type came along' },
      options('subagent-stop', { fetchImpl }),
    );

    expect(toolArgsIn(calls).observations).toEqual(['no agent type came along']);
  });

  it('caps a runaway synthesis at the observation limit', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: { episode_id: 'e1' } });

    await runHook(
      { session_id: SESSION_ID, last_assistant_message: 'y'.repeat(OBSERVATION_LIMIT + 500) },
      options('subagent-stop', { fetchImpl }),
    );

    const [observation] = toolArgsIn(calls).observations as readonly string[];
    expect(observation).toHaveLength(OBSERVATION_LIMIT);
  });

  it('pushes nothing when only the user spoke', async () => {
    writeFileSync(transcriptPath, `${USER_LINE}\n`);
    const { fetchImpl, calls } = transport({ structuredContent: {} });

    await runHook(
      { session_id: SESSION_ID, transcript_path: transcriptPath },
      options('stop', { fetchImpl }),
    );

    expect(calls).toEqual([]);
  });

  it('blocks in instruct mode when the model stored nothing', async () => {
    writeFileSync(transcriptPath, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
    const { fetchImpl, calls } = transport({ structuredContent: {} });

    await expect(
      runHook(
        { session_id: SESSION_ID, transcript_path: transcriptPath },
        options('stop', { fetchImpl, stopMode: 'instruct' }),
      ),
    ).resolves.toBe(2);

    expect(stderr).toEqual([STOP_INSTRUCTION]);
    expect(calls).toEqual([]);
  });

  it('never blocks twice while a block is already being processed', async () => {
    writeFileSync(transcriptPath, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
    const { fetchImpl } = transport({ structuredContent: {} });

    await expect(
      runHook(
        { session_id: SESSION_ID, transcript_path: transcriptPath, stop_hook_active: true },
        options('stop', { fetchImpl, stopMode: 'instruct' }),
      ),
    ).resolves.toBe(0);

    expect(stderr).toEqual([]);
  });

  it('lets the turn end in instruct mode once a reflection call is in the tail', async () => {
    const reflected = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'mcp__aion__reflection', input: {} }],
      },
    });
    writeFileSync(transcriptPath, `${ASSISTANT_LINE}\n${reflected}\n`);
    const { fetchImpl } = transport({ structuredContent: {} });

    await expect(
      runHook(
        { session_id: SESSION_ID, transcript_path: transcriptPath },
        options('stop', { fetchImpl, stopMode: 'instruct' }),
      ),
    ).resolves.toBe(0);

    expect(stderr).toEqual([]);
  });

  it('buffers a tool result without any round trip, then folds it into the next flush', async () => {
    const buffering = transport({ structuredContent: {} });
    await runHook(
      {
        session_id: SESSION_ID,
        tool_name: 'mcp__slack__conversations_history',
        tool_input: { channel: 'C123' },
        tool_response: { messages: ['the deploy is blocked'] },
      },
      options('post-tool-use', { fetchImpl: buffering.fetchImpl }),
    );

    expect(buffering.calls).toEqual([]);
    expect(readHookState(join(dir, 'state'), SESSION_ID).tools).toHaveLength(1);

    writeFileSync(transcriptPath, `${ASSISTANT_LINE}\n`);
    const flushing = transport({ structuredContent: { episode_id: 'e2' } });
    await runHook(
      { session_id: SESSION_ID, transcript_path: transcriptPath },
      options('session-end', { fetchImpl: flushing.fetchImpl }),
    );

    expect(toolArgsIn(flushing.calls).tool_executions).toEqual([
      {
        tool: 'mcp__slack__conversations_history',
        status: 'ok',
        input: '{"channel":"C123"}',
        output: '{"messages":["the deploy is blocked"]}',
        occurred_at: '2026-08-30T04:00:00.000Z',
      },
    ]);
  });

  it('stamps the claude session id over the one a reflection call carried', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: {} });

    await expect(
      runHook(
        {
          session_id: SESSION_ID,
          tool_name: 'mcp__aion__reflection',
          tool_input: { summary: 'the fix is a per-table split', session_id: 'transport-1' },
        },
        options('pre-tool-use', { fetchImpl }),
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual([]);
    expect(JSON.parse(stdout[0] ?? '{}')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { summary: 'the fix is a per-table split', session_id: SESSION_ID },
      },
    });
  });

  it('stamps a reflection call that carries no session id at all', async () => {
    const { fetchImpl } = transport({ structuredContent: {} });

    await runHook(
      {
        session_id: SESSION_ID,
        tool_name: 'mcp__aion__reflection',
        tool_input: { summary: 'the fix is a per-table split' },
      },
      options('pre-tool-use', { fetchImpl }),
    );

    expect(JSON.parse(stdout[0] ?? '{}').hookSpecificOutput.updatedInput).toEqual({
      summary: 'the fix is a per-table split',
      session_id: SESSION_ID,
    });
  });

  it('rewrites nothing when a reflection call already carries the right session id', async () => {
    const { fetchImpl } = transport({ structuredContent: {} });

    await expect(
      runHook(
        {
          session_id: SESSION_ID,
          tool_name: 'mcp__aion__reflection',
          tool_input: { summary: 'already right', session_id: SESSION_ID },
        },
        options('pre-tool-use', { fetchImpl }),
      ),
    ).resolves.toBe(0);

    expect(stdout).toEqual([]);
  });

  it('fills in the session id a recall call left out', async () => {
    const { fetchImpl } = transport({ structuredContent: {} });

    await runHook(
      {
        session_id: SESSION_ID,
        tool_name: 'mcp__aion__recall',
        tool_input: { query: 'why did the migration deadlock', session_id: '' },
      },
      options('pre-tool-use', { fetchImpl }),
    );

    expect(JSON.parse(stdout[0] ?? '{}')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { query: 'why did the migration deadlock', session_id: SESSION_ID },
      },
    });
  });

  it('leaves the session id a recall call chose for itself alone', async () => {
    const { fetchImpl } = transport({ structuredContent: {} });

    await expect(
      runHook(
        {
          session_id: SESSION_ID,
          tool_name: 'mcp__aion__recall',
          tool_input: { query: 'what did the other session decide', session_id: 'other-session' },
        },
        options('pre-tool-use', { fetchImpl }),
      ),
    ).resolves.toBe(0);

    expect(stdout).toEqual([]);
  });

  it('says nothing about a tool that is not aion', async () => {
    const { fetchImpl, calls } = transport({ structuredContent: {} });

    await expect(
      runHook(
        {
          session_id: SESSION_ID,
          tool_name: 'mcp__slack__conversations_history',
          tool_input: { channel: 'C123' },
        },
        options('pre-tool-use', { fetchImpl }),
      ),
    ).resolves.toBe(0);

    expect(stdout).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('says nothing when the payload carries no session id to stamp', async () => {
    const { fetchImpl } = transport({ structuredContent: {} });

    await expect(
      runHook(
        { tool_name: 'mcp__aion__reflection', tool_input: { summary: 'orphaned' } },
        options('pre-tool-use', { fetchImpl }),
      ),
    ).resolves.toBe(0);

    expect(stdout).toEqual([]);
  });

  it('drops the cursor file when the session ends', async () => {
    writeFileSync(transcriptPath, `${ASSISTANT_LINE}\n`);
    const { fetchImpl } = transport({ structuredContent: { episode_id: 'e3' } });

    await runHook(
      { session_id: SESSION_ID, transcript_path: transcriptPath },
      options('session-end', { fetchImpl }),
    );

    expect(() => readFileSync(stateFilePath(join(dir, 'state'), SESSION_ID), 'utf8')).toThrow();
  });

  it('exits 0 and stays silent on stdout when the service is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as FetchImpl;

    await expect(
      runHook({ session_id: SESSION_ID }, options('session-start', { fetchImpl })),
    ).resolves.toBe(0);

    expect(stdout).toEqual([]);
    expect(stderr[0]).toContain('fetch failed');
  });

  it('exits 0 when the service answers with a JSON-RPC error', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (body?.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'transport-1' },
        });
      }
      if (body?.method === 'tools/call') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'boom' } }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 202 });
    }) as unknown as FetchImpl;

    await expect(
      runHook({ session_id: SESSION_ID }, options('session-start', { fetchImpl })),
    ).resolves.toBe(0);

    expect(stdout).toEqual([]);
  });

  describe('with no anthropic key on the machine', () => {
    const AION_COMMAND = 'node /repo/packages/cli/dist/hook-main.js';

    const INSTALLED = {
      model: 'opus',
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume|clear|compact',
            hooks: [{ type: 'command', command: `${AION_COMMAND} session-start` }],
          },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'notify-send done' }] },
          { hooks: [{ type: 'command', command: `${AION_COMMAND} stop --mode push` }] },
        ],
      },
    };

    const LATER = (): Date => new Date('2026-08-30T05:00:00.000Z');

    let settingsPath: string;

    beforeEach(() => {
      settingsPath = join(dir, 'home', '.claude', 'settings.json');
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(INSTALLED));
    });

    function settings(): Record<string, unknown> {
      return JSON.parse(readFileSync(settingsPath, 'utf8'));
    }

    function backups(): readonly string[] {
      return readdirSync(join(dir, 'home', '.claude')).filter((name) => name.includes('.aion-'));
    }

    function traceLines(): readonly Record<string, unknown>[] {
      return readFileSync(join(dir, 'state', 'hooks.log'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line));
    }

    it.each(HOOK_EVENTS)('captures nothing on the %s event and exits 0', async (event) => {
      writeFileSync(transcriptPath, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
      const { fetchImpl, calls } = transport({ structuredContent: POPULATED_PACK });

      await expect(
        runHook(
          {
            session_id: SESSION_ID,
            transcript_path: transcriptPath,
            prompt: 'why did the v3.21.596 migration deadlock against read-only joins',
            tool_name: 'mcp__aion__reflection',
            tool_input: { summary: 'the fix is a per-table split' },
          },
          options(event, { fetchImpl, keyState: 'absent' }),
        ),
      ).resolves.toBe(0);

      expect(calls).toEqual([]);
    });

    it('records the keyless fire and what it removed in the trace', async () => {
      const { fetchImpl } = transport({ structuredContent: POPULATED_PACK });

      await runHook({ session_id: SESSION_ID }, options('session-end', { fetchImpl }));
      await runHook(
        { session_id: SESSION_ID },
        options('session-end', { fetchImpl, keyState: 'absent' }),
      );

      const [capturing, keyless] = traceLines();
      expect(capturing?.keyless).toBeUndefined();
      expect(keyless).toMatchObject({ event: 'session-end', exit: 0, keyless: true, removed: 2 });
    });

    it('backs the settings file up and strips its own entries', async () => {
      const { fetchImpl } = transport({ structuredContent: POPULATED_PACK });

      await runHook(
        { session_id: SESSION_ID },
        options('session-start', { fetchImpl, keyState: 'absent' }),
      );

      expect(describeAionHooks(settings())).toEqual([]);
      expect(JSON.parse(readFileSync(backupPath(settingsPath, NOW), 'utf8'))).toEqual(INSTALLED);
    });

    it('leaves every other setting and every foreign hook verbatim', async () => {
      const { fetchImpl } = transport({ structuredContent: POPULATED_PACK });

      await runHook(
        { session_id: SESSION_ID },
        options('session-end', { fetchImpl, keyState: 'absent' }),
      );

      expect(settings()).toEqual({
        model: 'opus',
        hooks: { Stop: [INSTALLED.hooks.Stop[0]] },
      });
    });

    it('finds nothing left to remove on the next fire and writes nothing', async () => {
      const { fetchImpl } = transport({ structuredContent: POPULATED_PACK });
      const absent = { fetchImpl, keyState: 'absent' } as const;

      await runHook({ session_id: SESSION_ID }, options('session-end', absent));
      const stripped = readFileSync(settingsPath, 'utf8');

      await runHook({ session_id: SESSION_ID }, options('session-end', { ...absent, now: LATER }));

      expect(readFileSync(settingsPath, 'utf8')).toBe(stripped);
      expect(backups()).toHaveLength(1);
      expect(traceLines()[1]).toMatchObject({ keyless: true, removed: 0 });
    });

    it('tells the session why capture stopped', async () => {
      const { fetchImpl } = transport({ structuredContent: POPULATED_PACK });

      await runHook(
        { session_id: SESSION_ID },
        options('session-start', { fetchImpl, keyState: 'absent' }),
      );

      expect(JSON.parse(stdout[0] ?? '{}')).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: KEYLESS_NOTICE,
        },
      });
    });

    it('says nothing to any event but session start', async () => {
      const { fetchImpl } = transport({ structuredContent: POPULATED_PACK });

      await runHook(
        {
          session_id: SESSION_ID,
          prompt: 'why did the migration deadlock against read-only joins',
        },
        options('prompt-submit', { fetchImpl, keyState: 'absent' }),
      );

      expect(stdout).toEqual([]);
    });

    it('never blocks a turn in instruct mode', async () => {
      writeFileSync(transcriptPath, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
      const { fetchImpl } = transport({ structuredContent: {} });

      await expect(
        runHook(
          { session_id: SESSION_ID, transcript_path: transcriptPath },
          options('stop', { fetchImpl, stopMode: 'instruct', keyState: 'absent' }),
        ),
      ).resolves.toBe(0);

      expect(stderr).toEqual([]);
    });
  });

  describe('with the key state unknown', () => {
    let settingsPath: string;

    beforeEach(() => {
      settingsPath = join(dir, 'home', '.claude', 'settings.json');
      mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    });

    it('recalls on session start and leaves the settings file alone', async () => {
      const { fetchImpl, calls } = transport({ structuredContent: POPULATED_PACK });

      await expect(
        runHook(
          { session_id: SESSION_ID },
          options('session-start', { fetchImpl, keyState: 'unknown' }),
        ),
      ).resolves.toBe(0);

      expect(toolNamesIn(calls)).toEqual(['recall']);
      expect(JSON.parse(stdout[0] ?? '{}').hookSpecificOutput.additionalContext).toContain(
        'Aion memory',
      );
      expect(readdirSync(join(dir, 'home', '.claude'))).toEqual(['settings.json']);
    });

    it('still blocks in instruct mode when the model stored nothing', async () => {
      writeFileSync(transcriptPath, `${USER_LINE}\n${ASSISTANT_LINE}\n`);
      const { fetchImpl } = transport({ structuredContent: {} });

      await expect(
        runHook(
          { session_id: SESSION_ID, transcript_path: transcriptPath },
          options('stop', { fetchImpl, stopMode: 'instruct', keyState: 'unknown' }),
        ),
      ).resolves.toBe(2);

      expect(stderr).toEqual([STOP_INSTRUCTION]);
    });
  });
});

describe('parseHookFlags', () => {
  it('defaults to push mode and a forty character floor', () => {
    expect(parseHookFlags(['stop'])).toEqual({ event: 'stop', stopMode: 'push', minChars: 40 });
  });

  it('reads the stop mode and the min-chars threshold', () => {
    expect(parseHookFlags(['stop', '--mode', 'instruct'])).toMatchObject({
      stopMode: 'instruct',
    });
    expect(parseHookFlags(['prompt-submit', '--min-chars', '80'])).toMatchObject({ minChars: 80 });
  });

  it('reports an unrecognised event as undefined rather than throwing', () => {
    expect(parseHookFlags(['nonsense']).event).toBeUndefined();
    expect(parseHookFlags([]).event).toBeUndefined();
  });
});

describe('parseHookInput', () => {
  it('treats empty, malformed, and non-object stdin as no input', () => {
    expect(parseHookInput('')).toEqual({});
    expect(parseHookInput('{not json')).toEqual({});
    expect(parseHookInput('[1,2]')).toEqual({});
  });
});

describe('parseRpcBody', () => {
  it('reads a plain JSON body and an SSE-framed one alike', () => {
    const message = { jsonrpc: '2.0', id: 1, result: { ok: true } };
    expect(parseRpcBody(JSON.stringify(message))).toEqual(message);
    expect(parseRpcBody(`event: message\ndata: ${JSON.stringify(message)}\n\n`)).toEqual(message);
  });

  it('takes the last framed message that carries a result', () => {
    const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' });
    const answer = { jsonrpc: '2.0', id: 1, result: { ok: true } };
    expect(parseRpcBody(`data: ${progress}\n\ndata: ${JSON.stringify(answer)}\n\n`)).toEqual(
      answer,
    );
  });
});

describe('mcpEndpoint', () => {
  it('defaults to 8765 and takes AION_MCP_PORT when it is a usable port', () => {
    expect(mcpEndpoint({})).toBe('http://127.0.0.1:8765/mcp');
    expect(mcpEndpoint({ AION_MCP_PORT: '9100' })).toBe('http://127.0.0.1:9100/mcp');
    expect(mcpEndpoint({ AION_MCP_PORT: 'nonsense' })).toBe('http://127.0.0.1:8765/mcp');
  });
});
