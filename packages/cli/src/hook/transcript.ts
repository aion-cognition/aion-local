import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The transcript is JSONL written by the harness for its own use. Its line shape is internal
 * and drifts between releases, so every read here is defensive: an unparseable line is
 * skipped, and a message is recognised by walking the shapes that plausibly carry one rather
 * than by asserting one schema.
 */

/** How far back a read starts when there is no cursor to trust. A whole transcript can be megabytes. */
export const FALLBACK_TAIL_BYTES = 64 * 1024;

export type TranscriptMessage = {
  readonly role: string;
  readonly text: string;
  readonly occurredAt: string | undefined;
};

export type TranscriptTail = {
  readonly messages: readonly TranscriptMessage[];
  /** Byte offset just past the last complete line, which is where the next read starts. */
  readonly offset: number;
  /** The lines as read. Stop's instruct mode inspects this for a reflection call the parsed messages do not carry. */
  readonly raw: string;
};

const EMPTY_TAIL: TranscriptTail = { messages: [], offset: 0, raw: '' };

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== undefined && record.type !== 'text') {
      continue;
    }
    if (typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.join('\n').trim();
}

/** ISO 8601 with an offset is what the reflection schema accepts; anything unparseable is dropped rather than guessed at. */
function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function roleOf(
  line: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
): string {
  if (message !== undefined && typeof message.role === 'string' && message.role !== '') {
    return message.role;
  }
  if (typeof line.role === 'string' && line.role !== '') {
    return line.role;
  }
  if (line.type === 'user' || line.type === 'assistant') {
    return line.type;
  }
  return '';
}

/**
 * Returns nothing for every line that carries no readable text: tool results, thinking
 * blocks, summaries, meta rows, and whatever a future release adds. Silence is the correct
 * answer for all of them.
 */
export function extractMessage(value: unknown): TranscriptMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const line = value as Record<string, unknown>;
  const nested = line.message;
  const message =
    typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : undefined;

  const role = roleOf(line, message);
  if (role === '') {
    return undefined;
  }

  const text = textFromContent(message?.content ?? line.content ?? line.text);
  if (text === '') {
    return undefined;
  }

  const occurredAt =
    normalizeTimestamp(line.timestamp) ??
    normalizeTimestamp(message?.timestamp) ??
    normalizeTimestamp(line.occurred_at);

  return { role, text, occurredAt };
}

export function parseTranscriptLines(raw: string): readonly TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = extractMessage(parsed);
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

function readRange(path: string, from: number | undefined): { text: string; start: number } {
  const handle = openSync(path, 'r');
  try {
    const { size } = fstatSync(handle);
    const trusted = from !== undefined && from >= 0 && from <= size;
    const start = trusted ? from : Math.max(0, size - FALLBACK_TAIL_BYTES);
    const length = size - start;
    if (length <= 0) {
      return { text: '', start };
    }
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    if (trusted || start === 0) {
      return { text, start };
    }
    // A byte offset lands mid-line. The first partial line is dropped rather than parsed,
    // which costs one message and never produces a corrupt one.
    const firstBreak = text.indexOf('\n');
    if (firstBreak === -1) {
      return { text: '', start: size };
    }
    return {
      text: text.slice(firstBreak + 1),
      start: start + Buffer.byteLength(text.slice(0, firstBreak + 1)),
    };
  } finally {
    closeSync(handle);
  }
}

/**
 * Everything the transcript gained since `from`. A missing or unreadable file yields an
 * empty tail rather than an error: a hook never fails a turn over a file it does not own.
 */
export function readTranscriptTail(path: string, from: number | undefined): TranscriptTail {
  let range: { text: string; start: number };
  try {
    range = readRange(path, from);
  } catch {
    return EMPTY_TAIL;
  }
  if (range.text === '') {
    return { messages: [], offset: range.start, raw: '' };
  }

  const lines = range.text.split('\n');
  const complete = lines.slice(0, -1);
  let consumed = 0;
  for (const line of complete) {
    consumed += Buffer.byteLength(line, 'utf8') + 1;
  }
  const raw = complete.join('\n');
  return { messages: parseTranscriptLines(raw), offset: range.start + consumed, raw };
}

/**
 * Whether the model already stored this turn itself. The tool call appears in the transcript
 * under the name the MCP registration gives it, so both the namespaced form and the bare tool
 * name count.
 */
export function mentionsReflectionCall(raw: string): boolean {
  return raw.includes('mcp__aion__reflection') || raw.includes('"name":"reflection"');
}

export function hasAssistantText(messages: readonly TranscriptMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant');
}
