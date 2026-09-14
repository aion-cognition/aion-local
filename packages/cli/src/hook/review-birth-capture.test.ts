import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runHook } from './run.js';
import { readHookState } from './state.js';
import type { Harness, HookOptions } from './options.js';
import { FALLBACK_TAIL_BYTES } from './transcript.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function line(harness: Harness, text: string): string {
  const timestamp = '2026-09-14T16:00:00.000Z';
  return `${JSON.stringify(
    harness === 'claude'
      ? { type: 'assistant', timestamp, message: { role: 'assistant', content: text } }
      : { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: text } },
  )}\n`;
}

function fixture(harness: Harness, large: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'aion-birth-capture-'));
  dirs.push(dir);
  const path = join(dir, 'transcript.jsonl');
  const stateDir = join(dir, 'state');
  const calls: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const metadata = `${JSON.stringify({ type: 'session_meta', payload: { id: 'capture-session', context: 'x'.repeat(large ? FALLBACK_TAIL_BYTES + 100 : 10) } })}\n`;
  writeFileSync(path, metadata + line(harness, 'post-birth conversation to recover'));
  const options: HookOptions = {
    event: 'stop',
    harness,
    stopMode: 'push',
    minChars: 1,
    route: 'keyed',
    stateDir,
    endpoint: 'http://capture.invalid/mcp',
    timeoutMs: 1000,
    now: () => new Date('2026-09-14T16:01:00.000Z'),
    stdout: () => undefined,
    stderr: (value) => stderr.push(value),
    fetchImpl: async (_url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.method === 'tools/call') {
        calls.push(body.params.arguments);
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result:
            body.method === 'tools/call'
              ? { structuredContent: { episode_id: 'accepted', queued: true, lane: 'interactive' } }
              : {},
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'mock' } },
      );
    },
  };
  const fire = () => runHook({ session_id: 'capture-session', transcript_path: path }, options);
  return { path, stateDir, calls, stderr, fire };
}

it.each(['claude', 'codex'] as const)(
  'recovers post-birth conversation after %s loses a cursor in a large transcript',
  async (harness) => {
    const f = fixture(harness, true);
    expect(await f.fire()).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ turns: [{ text: 'post-birth conversation to recover' }] });
    expect(f.stderr).toEqual([]);
  },
);

it('continues to capture later conversation after an empty large-transcript read', async () => {
  const f = fixture('claude', true);
  await f.fire();
  f.calls.splice(0);
  appendFileSync(f.path, line('claude', 'a later message must not be lost'));
  expect(await f.fire()).toBe(0);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.turns).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'a later message must not be lost' })]),
  );
  expect(readHookState(f.stateDir, 'capture-session').offset).toBeGreaterThan(0);
});

it.each(['claude', 'codex'] as const)(
  'captures a first %s message and then only its appended successor with a small transcript',
  async (harness) => {
    const f = fixture(harness, false);
    expect(await f.fire()).toBe(0);
    expect(f.calls).toHaveLength(1);
    f.calls.splice(0);
    appendFileSync(f.path, line(harness, 'successor'));
    expect(await f.fire()).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ turns: [{ text: 'successor' }] });
  },
);
