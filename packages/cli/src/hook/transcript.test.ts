import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractMessage,
  hasAssistantText,
  mentionsReflectionCall,
  parseTranscriptLines,
  readTranscriptTail,
} from './transcript.js';

const WELL_FORMED = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'the deadlock is the DDL' }] },
  timestamp: '2026-08-30T03:00:00.000Z',
});

const DRIFTED_FLAT_CONTENT = JSON.stringify({
  role: 'user',
  content: 'why did the migration hang',
  occurred_at: '2026-08-30T02:59:00Z',
});

const DRIFTED_TYPE_ONLY = JSON.stringify({
  type: 'user',
  message: { content: [{ text: 'no block type at all' }] },
});

const TOOL_RESULT_ONLY = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: 'rows: 12' }] },
});

const GARBAGE = '{"type":"assistant", this is not json';

describe('extractMessage', () => {
  it('reads role, text, and timestamp from the nested message shape', () => {
    expect(extractMessage(JSON.parse(WELL_FORMED))).toEqual({
      role: 'assistant',
      text: 'the deadlock is the DDL',
      occurredAt: '2026-08-30T03:00:00.000Z',
    });
  });

  it('reads a flat line whose content is a plain string', () => {
    expect(extractMessage(JSON.parse(DRIFTED_FLAT_CONTENT))).toEqual({
      role: 'user',
      text: 'why did the migration hang',
      occurredAt: '2026-08-30T02:59:00.000Z',
    });
  });

  it('takes the role from the line type and a text block that declares no type', () => {
    expect(extractMessage(JSON.parse(DRIFTED_TYPE_ONLY))).toEqual({
      role: 'user',
      text: 'no block type at all',
      occurredAt: undefined,
    });
  });

  it('returns nothing for a line whose blocks carry no text', () => {
    expect(extractMessage(JSON.parse(TOOL_RESULT_ONLY))).toBeUndefined();
  });

  it('returns nothing for shapes that are not objects', () => {
    expect(extractMessage(null)).toBeUndefined();
    expect(extractMessage('assistant')).toBeUndefined();
    expect(extractMessage([{ role: 'user', text: 'x' }])).toBeUndefined();
  });

  it('drops a timestamp it cannot parse rather than passing it on', () => {
    const message = extractMessage({ role: 'user', content: 'hi', timestamp: 'yesterday' });
    expect(message?.occurredAt).toBeUndefined();
  });
});

describe('parseTranscriptLines', () => {
  it('skips unparseable lines and keeps the rest', () => {
    const messages = parseTranscriptLines(
      [GARBAGE, WELL_FORMED, '', 'null', DRIFTED_FLAT_CONTENT].join('\n'),
    );

    expect(messages.map((message) => message.role)).toEqual(['assistant', 'user']);
  });
});

describe('readTranscriptTail', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-transcript-'));
    path = join(dir, 'transcript.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the whole file from offset zero and reports where to resume', () => {
    const body = `${WELL_FORMED}\n${DRIFTED_FLAT_CONTENT}\n`;
    writeFileSync(path, body);

    const tail = readTranscriptTail(path, 0);

    expect(tail.messages).toHaveLength(2);
    expect(tail.offset).toBe(Buffer.byteLength(body));
  });

  it('reads only what arrived after the cursor', () => {
    const first = `${WELL_FORMED}\n`;
    writeFileSync(path, first);
    const opening = readTranscriptTail(path, 0);

    writeFileSync(path, `${first}${DRIFTED_FLAT_CONTENT}\n`);
    const tail = readTranscriptTail(path, opening.offset);

    expect(tail.messages.map((message) => message.text)).toEqual(['why did the migration hang']);
  });

  it('leaves a partial trailing line for the next read', () => {
    writeFileSync(path, `${WELL_FORMED}\n${DRIFTED_FLAT_CONTENT.slice(0, 20)}`);

    const tail = readTranscriptTail(path, 0);

    expect(tail.messages).toHaveLength(1);
    expect(tail.offset).toBe(Buffer.byteLength(`${WELL_FORMED}\n`));
  });

  it('starts from the tail rather than the whole file when the cursor is unusable', () => {
    writeFileSync(path, `${WELL_FORMED}\n`);

    const beyondEnd = readTranscriptTail(path, 10_000_000);

    expect(beyondEnd.messages).toHaveLength(1);
    expect(readTranscriptTail(path, undefined).messages).toHaveLength(1);
  });

  it('returns an empty tail for a file that is not there', () => {
    expect(readTranscriptTail(join(dir, 'absent.jsonl'), 0)).toEqual({
      messages: [],
      offset: 0,
      raw: '',
    });
  });
});

describe('mentionsReflectionCall', () => {
  it('recognises the namespaced tool name the harness writes', () => {
    expect(mentionsReflectionCall('{"type":"tool_use","name":"mcp__aion__reflection"}')).toBe(true);
    expect(mentionsReflectionCall('{"type":"tool_use","name":"reflection"}')).toBe(true);
  });

  it('does not fire on the word alone', () => {
    expect(mentionsReflectionCall('some reflection on the design')).toBe(false);
  });
});

describe('hasAssistantText', () => {
  it('is false when only the user spoke', () => {
    expect(hasAssistantText([{ role: 'user', text: 'hi', occurredAt: undefined }])).toBe(false);
    expect(hasAssistantText([{ role: 'assistant', text: 'hi', occurredAt: undefined }])).toBe(true);
  });
});
