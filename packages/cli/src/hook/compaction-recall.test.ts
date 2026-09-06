import { describe, expect, it, vi } from 'vitest';

import { promptSubmit, sessionStart } from './events.js';
import type { FetchImpl } from './mcp.js';
import { HOOK_TIMEOUT_MS, type HookOptions } from './options.js';

/**
 * Claude Code re-primes a session with a SessionStart event on `/clear`, `/resume`, and a
 * context compaction, distinguished only by an input field named `source`. Whether that field
 * ever reaches the recall call, and whether it reaches it as anything other than an ordinary
 * repeat, is what these tests read off the real hook code rather than off the source.
 */

const SESSION_ID = 'claude-session-compact-1';
const NOW = new Date('2026-09-06T04:00:00.000Z');

const EMPTY_PACK = { rendered_text: '# Memory\n\nNo memories matched this query.' };

type RecordedCall = { readonly method: string; readonly body: Record<string, unknown> | undefined };

function transport(): { fetchImpl: FetchImpl; calls: RecordedCall[] } {
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
      const frame = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { structuredContent: EMPTY_PACK },
      });
      return new Response(`event: message\ndata: ${frame}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(null, { status: 202 });
  });
  return { fetchImpl: impl as unknown as FetchImpl, calls };
}

function toolArgsIn(calls: readonly RecordedCall[]): Record<string, unknown> {
  const call = calls.find((entry) => entry.body?.method === 'tools/call');
  const params = call?.body?.params as Record<string, unknown>;
  return params.arguments as Record<string, unknown>;
}

function options(fetchImpl: FetchImpl): HookOptions {
  return {
    event: 'session-start',
    harness: 'claude',
    stopMode: 'push',
    minChars: 40,
    keyState: 'present',
    settingsPath: '/dev/null',
    stateDir: '/dev/null',
    endpoint: 'http://127.0.0.1:8765/mcp',
    fetchImpl,
    timeoutMs: HOOK_TIMEOUT_MS,
    now: () => NOW,
    stdout: (): void => undefined,
    stderr: (): void => undefined,
  };
}

describe('a SessionStart recall after a context compaction', () => {
  it('marks a reset only when the harness names the source compact', async () => {
    const startup = transport();
    await sessionStart({
      input: { session_id: SESSION_ID, source: 'startup' },
      options: options(startup.fetchImpl),
    });
    expect(toolArgsIn(startup.calls).reset_delivery_suppression).toBeUndefined();

    const compact = transport();
    await sessionStart({
      input: { session_id: SESSION_ID, source: 'compact' },
      options: options(compact.fetchImpl),
    });
    expect(toolArgsIn(compact.calls).reset_delivery_suppression).toBe(true);
  });

  it('marks no reset for the other SessionStart sources, clear and resume included', async () => {
    for (const input of [
      { session_id: SESSION_ID, source: 'resume' },
      { session_id: SESSION_ID, source: 'clear' },
      { session_id: SESSION_ID },
    ]) {
      const { fetchImpl, calls } = transport();
      await sessionStart({ input, options: options(fetchImpl) });
      expect(toolArgsIn(calls).reset_delivery_suppression).toBeUndefined();
    }
  });

  it('never marks a reset on an ordinary prompt, even mid-session', async () => {
    const { fetchImpl, calls } = transport();
    await promptSubmit({
      input: {
        session_id: SESSION_ID,
        prompt: 'why did the migration deadlock against read-only joins',
      },
      options: options(fetchImpl),
    });
    expect(toolArgsIn(calls).reset_delivery_suppression).toBeUndefined();
  });
});
