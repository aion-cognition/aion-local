import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  extractRolloutMessage,
  parseRolloutLines,
  readRolloutTail,
  rolloutFingerprint,
} from './codex-rollout.js';

/** Bytes one `readSync` may answer with, however many the caller asked for. Zero is the real call. */
const shortRead = vi.hoisted(() => ({ bytes: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readSync: (
      handle: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      const asked = shortRead.bytes === 0 ? length : Math.min(length, shortRead.bytes);
      return actual.readSync(handle, buffer, offset, asked, position);
    },
  };
});

const SESSION_META = JSON.stringify({
  timestamp: '2026-09-05T18:00:00.000Z',
  type: 'session_meta',
  payload: {
    session_id: '019f7d6b-c1f3-72f2-8a1c-2f0d6f3b9a11',
    id: '019f7d6b-c1f3-72f2-8a1c-2f0d6f3b9a11',
    timestamp: '2026-09-05T18:00:00.000Z',
    cwd: '/work',
    originator: 'codex_cli_rs',
    cli_version: '0.144.6',
    source: 'cli',
    history_mode: 'legacy',
  },
});

const OTHER_SESSION_META = JSON.stringify({
  timestamp: '2026-09-05T20:00:00.000Z',
  type: 'session_meta',
  payload: {
    session_id: '019f8a20-4d11-7cc0-9b3e-77e0a1b45c02',
    id: '019f8a20-4d11-7cc0-9b3e-77e0a1b45c02',
    timestamp: '2026-09-05T20:00:00.000Z',
    cwd: '/work',
    originator: 'codex_cli_rs',
    cli_version: '0.153.4',
    source: 'cli',
    history_mode: 'paginated',
  },
});

const LEGACY_USER = JSON.stringify({
  timestamp: '2026-09-05T18:00:01.000Z',
  type: 'event_msg',
  payload: { type: 'user_message', message: 'why did the migration hang' },
});

const LEGACY_ASSISTANT = JSON.stringify({
  timestamp: '2026-09-05T18:00:03.000Z',
  type: 'event_msg',
  payload: { type: 'agent_message', message: 'the deadlock is the DDL' },
});

/** Injected instructions ride into history as an ordinary user message and are not a turn. */
const INSTRUCTIONS_FRAGMENT = JSON.stringify({
  timestamp: '2026-09-05T18:00:01.100Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '<user_instructions>AGENTS.md</user_instructions>' }],
  },
  metadata: { client_authored: true },
});

const ABORT_FRAGMENT = JSON.stringify({
  timestamp: '2026-09-05T18:00:01.200Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'The previous turn was aborted.' }],
  },
});

const REASONING = JSON.stringify({
  timestamp: '2026-09-05T18:00:02.000Z',
  type: 'response_item',
  payload: {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'the DDL waits behind a read lock' }],
    encrypted_content: 'opaque',
  },
});

const TURN_CONTEXT = JSON.stringify({
  timestamp: '2026-09-05T18:00:00.500Z',
  type: 'turn_context',
  payload: {
    turn_id: 'turn-1',
    cwd: '/work',
    model: 'gpt-5.3-codex',
    approval_policy: 'on-request',
  },
});

const TASK_COMPLETE = JSON.stringify({
  timestamp: '2026-09-05T18:00:04.000Z',
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    turn_id: 'turn-1',
    last_agent_message: 'the deadlock is the DDL',
  },
});

const PAGINATED_USER = JSON.stringify({
  timestamp: '2026-09-05T19:00:01.000Z',
  ordinal: 4,
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: '019f8a20-4d11-7cc0-9b3e-77e0a1b45c02',
    turn_id: 'turn-2',
    item: {
      type: 'UserMessage',
      id: 'msg-1',
      content: [
        { type: 'text', text: 'first line' },
        { type: 'image', image_url: 'file:///shot.png' },
        { type: 'Text', text: 'second line' },
      ],
    },
    completed_at_ms: 0,
  },
});

const PAGINATED_ASSISTANT = JSON.stringify({
  timestamp: '2026-09-05T19:00:02.000Z',
  ordinal: 5,
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: '019f8a20-4d11-7cc0-9b3e-77e0a1b45c02',
    turn_id: 'turn-2',
    item: {
      type: 'AgentMessage',
      id: 'amsg-1',
      content: [
        { type: 'Text', text: 'the index is missing' },
        { type: 'text', text: 'and the plan says so' },
      ],
    },
    completed_at_ms: 0,
  },
});

const PAGINATED_COMMAND = JSON.stringify({
  timestamp: '2026-09-05T19:00:03.000Z',
  ordinal: 6,
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: '019f8a20-4d11-7cc0-9b3e-77e0a1b45c02',
    turn_id: 'turn-2',
    item: { type: 'CommandExecution', id: 'cmd-1', command: 'npm run test:unit' },
    completed_at_ms: 0,
  },
});

const COMPACTED = JSON.stringify({
  timestamp: '2026-09-05T19:00:04.000Z',
  ordinal: 7,
  type: 'compacted',
  payload: {
    message: 'the window so far',
    replacement_history: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first line' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'the index is missing' }],
      },
    ],
    window_number: 1,
    window_id: '019f8a20-4d11-7cc0-9b3e-77e0a1b45c03',
  },
});

const GARBAGE = '{"type":"event_msg", this is not json';

function fileOf(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

describe('extractRolloutMessage', () => {
  it('reads a legacy user turn from the event that brackets it', () => {
    expect(extractRolloutMessage(JSON.parse(LEGACY_USER))).toEqual({
      role: 'user',
      text: 'why did the migration hang',
      occurredAt: '2026-09-05T18:00:01.000Z',
    });
  });

  it('reads a legacy assistant turn from the event that brackets it', () => {
    expect(extractRolloutMessage(JSON.parse(LEGACY_ASSISTANT))).toEqual({
      role: 'assistant',
      text: 'the deadlock is the DDL',
      occurredAt: '2026-09-05T18:00:03.000Z',
    });
  });

  it('joins the text entries of a paginated user item and drops the image', () => {
    expect(extractRolloutMessage(JSON.parse(PAGINATED_USER))).toEqual({
      role: 'user',
      text: 'first line\nsecond line',
      occurredAt: '2026-09-05T19:00:01.000Z',
    });
  });

  it('joins the text entries of a paginated assistant item whatever case they declare', () => {
    expect(extractRolloutMessage(JSON.parse(PAGINATED_ASSISTANT))).toEqual({
      role: 'assistant',
      text: 'the index is missing\nand the plan says so',
      occurredAt: '2026-09-05T19:00:02.000Z',
    });
  });

  it('returns nothing for a response item, whatever role it claims', () => {
    expect(extractRolloutMessage(JSON.parse(INSTRUCTIONS_FRAGMENT))).toBeUndefined();
    expect(extractRolloutMessage(JSON.parse(ABORT_FRAGMENT))).toBeUndefined();
    expect(extractRolloutMessage(JSON.parse(REASONING))).toBeUndefined();
  });

  it('returns nothing for the line types that carry no turn', () => {
    expect(extractRolloutMessage(JSON.parse(SESSION_META))).toBeUndefined();
    expect(extractRolloutMessage(JSON.parse(TURN_CONTEXT))).toBeUndefined();
    expect(extractRolloutMessage(JSON.parse(TASK_COMPLETE))).toBeUndefined();
    expect(extractRolloutMessage(JSON.parse(COMPACTED))).toBeUndefined();
  });

  it('returns nothing for a completed item that is not a message', () => {
    expect(extractRolloutMessage(JSON.parse(PAGINATED_COMMAND))).toBeUndefined();
  });

  it('returns nothing when the message field is not a string', () => {
    expect(
      extractRolloutMessage({
        timestamp: '2026-09-05T18:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: { text: 'nested' } },
      }),
    ).toBeUndefined();
  });

  it('returns nothing when the content entries hold no text', () => {
    expect(
      extractRolloutMessage({
        timestamp: '2026-09-05T19:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'image', image_url: 'file:///a.png' }] },
        },
      }),
    ).toBeUndefined();
  });

  it('leaves the timestamp out when the line carries none it can pass on', () => {
    expect(
      extractRolloutMessage({
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'no timestamp here' },
      }),
    ).toEqual({ role: 'assistant', text: 'no timestamp here', occurredAt: undefined });
  });

  it('returns nothing for a turn whose text is only whitespace', () => {
    expect(
      extractRolloutMessage({
        timestamp: '2026-09-05T18:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: '   ' },
      }),
    ).toBeUndefined();
    expect(
      extractRolloutMessage({
        timestamp: '2026-09-05T19:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text: '  \n  ' }] },
        },
      }),
    ).toBeUndefined();
  });

  it('returns nothing for shapes that are not objects', () => {
    expect(extractRolloutMessage(null)).toBeUndefined();
    expect(extractRolloutMessage('event_msg')).toBeUndefined();
    expect(extractRolloutMessage([{ type: 'event_msg' }])).toBeUndefined();
  });
});

describe('parseRolloutLines', () => {
  it('keeps the two legacy turns and nothing else in the window around them', () => {
    const messages = parseRolloutLines(
      [
        SESSION_META,
        TURN_CONTEXT,
        LEGACY_USER,
        INSTRUCTIONS_FRAGMENT,
        ABORT_FRAGMENT,
        REASONING,
        LEGACY_ASSISTANT,
        TASK_COMPLETE,
      ].join('\n'),
    );

    expect(messages).toEqual([
      {
        role: 'user',
        text: 'why did the migration hang',
        occurredAt: '2026-09-05T18:00:01.000Z',
      },
      {
        role: 'assistant',
        text: 'the deadlock is the DDL',
        occurredAt: '2026-09-05T18:00:03.000Z',
      },
    ]);
  });

  it('reads a paginated window that numbers its lines', () => {
    const messages = parseRolloutLines(
      [PAGINATED_USER, PAGINATED_COMMAND, PAGINATED_ASSISTANT].join('\n'),
    );

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('does not restate a message that a compaction line replays', () => {
    const messages = parseRolloutLines([PAGINATED_USER, PAGINATED_ASSISTANT, COMPACTED].join('\n'));

    expect(messages.map((message) => message.text)).toEqual([
      'first line\nsecond line',
      'the index is missing\nand the plan says so',
    ]);
  });

  it('skips unparseable lines and keeps the rest', () => {
    const messages = parseRolloutLines([GARBAGE, LEGACY_USER, '', 'null'].join('\n'));

    expect(messages.map((message) => message.role)).toEqual(['user']);
  });
});

describe('rolloutFingerprint', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-rollout-'));
    path = join(dir, 'rollout.jsonl');
  });

  afterEach(() => {
    shortRead.bytes = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes the first complete line and nothing after it', () => {
    writeFileSync(path, fileOf(SESSION_META, LEGACY_USER));

    expect(rolloutFingerprint(path)).toBe(createHash('sha256').update(SESSION_META).digest('hex'));
  });

  it('survives an append, because only the first line feeds it', () => {
    writeFileSync(path, fileOf(SESSION_META));
    const opening = rolloutFingerprint(path);

    writeFileSync(path, fileOf(SESSION_META, LEGACY_USER, LEGACY_ASSISTANT));

    expect(rolloutFingerprint(path)).toBe(opening);
  });

  it('changes when the file is replaced by another session', () => {
    writeFileSync(path, fileOf(SESSION_META));
    const opening = rolloutFingerprint(path);

    writeFileSync(path, fileOf(OTHER_SESSION_META));

    expect(rolloutFingerprint(path)).not.toBe(opening);
  });

  it('hashes the same line when the reads come back short of what was asked for', () => {
    writeFileSync(path, fileOf(SESSION_META, LEGACY_USER));
    shortRead.bytes = 16;

    expect(rolloutFingerprint(path)).toBe(createHash('sha256').update(SESSION_META).digest('hex'));
  });

  it('says nothing about a file with no complete line yet', () => {
    writeFileSync(path, SESSION_META.slice(0, 40));

    expect(rolloutFingerprint(path)).toBeUndefined();
  });

  it('says nothing about an empty or absent file', () => {
    writeFileSync(path, '');

    expect(rolloutFingerprint(path)).toBeUndefined();
    expect(rolloutFingerprint(join(dir, 'absent.jsonl'))).toBeUndefined();
  });
});

describe('readRolloutTail', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-rollout-'));
    path = join(dir, 'rollout.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a legacy window from the start and reports where to resume', () => {
    const body = fileOf(SESSION_META, LEGACY_USER, INSTRUCTIONS_FRAGMENT, LEGACY_ASSISTANT);
    writeFileSync(path, body);

    const tail = readRolloutTail(path, 0, undefined);

    expect(tail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(tail.offset).toBe(Buffer.byteLength(body));
    expect(tail.raw).toContain('"agent_message"');
    expect(tail.fingerprint).toBe(createHash('sha256').update(SESSION_META).digest('hex'));
  });

  it('reads only what arrived after the cursor when the file is still the same one', () => {
    const opening = fileOf(SESSION_META, LEGACY_USER);
    writeFileSync(path, opening);
    const first = readRolloutTail(path, 0, undefined);

    writeFileSync(path, `${opening}${fileOf(LEGACY_ASSISTANT)}`);
    const tail = readRolloutTail(path, first.offset, first.fingerprint);

    expect(tail.messages.map((message) => message.text)).toEqual(['the deadlock is the DDL']);
    expect(tail.fingerprint).toBe(first.fingerprint);
  });

  it('ignores the cursor when the first line says the file was rewritten under it', () => {
    writeFileSync(path, fileOf(SESSION_META, LEGACY_USER));
    const first = readRolloutTail(path, 0, undefined);

    const replaced = fileOf(
      OTHER_SESSION_META,
      PAGINATED_USER,
      PAGINATED_COMMAND,
      PAGINATED_ASSISTANT,
    );
    writeFileSync(path, replaced);
    expect(Buffer.byteLength(replaced)).toBeGreaterThan(first.offset);

    const tail = readRolloutTail(path, first.offset, first.fingerprint);

    expect(tail.messages.map((message) => message.text)).toEqual([
      'first line\nsecond line',
      'the index is missing\nand the plan says so',
    ]);
    expect(tail.offset).toBe(Buffer.byteLength(replaced));
    expect(tail.fingerprint).toBe(createHash('sha256').update(OTHER_SESSION_META).digest('hex'));
  });

  it('leaves a line that is still being written for the next read', () => {
    const complete = fileOf(SESSION_META, LEGACY_USER);
    writeFileSync(path, `${complete}${LEGACY_ASSISTANT.slice(0, 30)}`);

    const tail = readRolloutTail(path, 0, undefined);

    expect(tail.messages.map((message) => message.role)).toEqual(['user']);
    expect(tail.offset).toBe(Buffer.byteLength(complete));
  });

  it('returns an empty tail for a file that is not there', () => {
    expect(readRolloutTail(join(dir, 'absent.jsonl'), 12, undefined)).toEqual({
      messages: [],
      offset: 12,
      raw: '',
      fingerprint: undefined,
    });
    expect(readRolloutTail(join(dir, 'absent.jsonl'), undefined, undefined).offset).toBe(0);
  });

  it('returns an empty tail for a file that has nothing in it yet', () => {
    writeFileSync(path, '');

    expect(readRolloutTail(path, 0, undefined)).toEqual({
      messages: [],
      offset: 0,
      raw: '',
      fingerprint: undefined,
    });
  });

  it('starts from the tail rather than the cursor when the cursor is past the end', () => {
    writeFileSync(path, fileOf(SESSION_META, LEGACY_USER));

    const tail = readRolloutTail(path, 10_000_000, undefined);

    expect(tail.messages.map((message) => message.role)).toEqual(['user']);
  });
});
