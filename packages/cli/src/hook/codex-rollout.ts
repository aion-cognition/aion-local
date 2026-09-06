import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { readRange, type TranscriptMessage } from './transcript.js';

/**
 * Codex writes a rollout file, which is JSONL like the Claude transcript but with a different
 * line shape and a much larger share of lines that are not turns. Only the four event payloads
 * below carry a turn. Everything else on disk is context Codex assembled for the model:
 * response items, reasoning, turn context, token usage, and the history a compaction restates.
 * Reading a response item would be the tempting shortcut and the wrong one, because thirteen
 * kinds of injected context arrive there wearing role "user".
 */

export type RolloutTail = {
  readonly messages: readonly TranscriptMessage[];
  /** Byte offset just past the last complete line, which is where the next read starts. */
  readonly offset: number;
  readonly raw: string;
  /** Identifies the file the offset belongs to. Undefined when there is nothing to key on. */
  readonly fingerprint: string | undefined;
};

/**
 * How far a fingerprint read scans for the end of the first line. The session metadata line
 * carries the base instructions, so it is long, but a line past this cap means the file is not
 * shaped the way a rollout is and keying on it would be guesswork.
 */
const FIRST_LINE_SCAN_BYTES = 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

function readFirstLine(path: string): string | undefined {
  const handle = openSync(path, 'r');
  try {
    const { size } = fstatSync(handle);
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < size && position < FIRST_LINE_SCAN_BYTES) {
      const length = Math.min(READ_CHUNK_BYTES, size - position);
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, position);
      position += length;
      chunks.push(buffer);
      // The newline is found in the bytes, not in a decoded string, because a chunk boundary can
      // fall inside a multi-byte character and decoding each chunk alone would mangle it.
      const scanned = chunks.length === 1 ? buffer : Buffer.concat(chunks);
      const firstBreak = scanned.indexOf(0x0a);
      if (firstBreak !== -1) {
        return scanned.subarray(0, firstBreak).toString('utf8');
      }
    }
    return undefined;
  } finally {
    closeSync(handle);
  }
}

/**
 * A stable name for the file behind an offset. Codex migrates a legacy rollout by rewriting it
 * at the same path and restoring the original mtime, so size and mtime cannot tell a resumed
 * file from a replaced one. The first line can: it is the session metadata, and a rewrite
 * changes it.
 */
export function rolloutFingerprint(path: string): string | undefined {
  let first: string | undefined;
  try {
    first = readFirstLine(path);
  } catch {
    return undefined;
  }
  if (first === undefined) {
    return undefined;
  }
  return createHash('sha256').update(first).digest('hex');
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * The user item's entries are tagged `text` and the agent item's are tagged `Text`. Both spellings
 * are accepted on both sides rather than encoding an asymmetry that is an accident of two Rust
 * enums, one of which renames its variants and the other of which does not.
 */
function textFromItemContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const entry of content) {
    const record = objectOf(entry);
    if (record === undefined) {
      continue;
    }
    if (record.type !== 'text' && record.type !== 'Text') {
      continue;
    }
    if (typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.join('\n');
}

function turnFromCompletedItem(
  payload: Record<string, unknown>,
): { role: string; text: string } | undefined {
  const item = objectOf(payload.item);
  if (item === undefined) {
    return undefined;
  }
  if (item.type !== 'UserMessage' && item.type !== 'AgentMessage') {
    return undefined;
  }
  const role = item.type === 'UserMessage' ? 'user' : 'assistant';
  return { role, text: textFromItemContent(item.content) };
}

function turnFromPayload(
  payload: Record<string, unknown>,
): { role: string; text: string } | undefined {
  if (payload.type === 'user_message' || payload.type === 'agent_message') {
    if (typeof payload.message !== 'string') {
      return undefined;
    }
    const role = payload.type === 'user_message' ? 'user' : 'assistant';
    return { role, text: payload.message };
  }
  if (payload.type === 'item_completed') {
    return turnFromCompletedItem(payload);
  }
  return undefined;
}

/** Returns nothing for every line that is not one of the four events that bracket a real turn. */
export function extractRolloutMessage(value: unknown): TranscriptMessage | undefined {
  const line = objectOf(value);
  if (line?.type !== 'event_msg') {
    return undefined;
  }
  const payload = objectOf(line.payload);
  if (payload === undefined) {
    return undefined;
  }
  const turn = turnFromPayload(payload);
  if (turn === undefined || turn.text === '') {
    return undefined;
  }
  const occurredAt = typeof line.timestamp === 'string' ? line.timestamp : undefined;
  return { role: turn.role, text: turn.text, occurredAt };
}

export function parseRolloutLines(raw: string): readonly TranscriptMessage[] {
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
    const message = extractRolloutMessage(parsed);
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

/**
 * Everything the rollout gained since `from`. A cursor is only honoured while the file still
 * fingerprints the way it did when the cursor was written; otherwise the offset describes bytes
 * that no longer exist and the read falls back to the tail. A missing or unreadable file yields
 * an empty tail rather than an error, so a hook never fails a turn over a file it does not own.
 */
export function readRolloutTail(
  path: string,
  from: number | undefined,
  expectedFingerprint: string | undefined,
): RolloutTail {
  const fingerprint = rolloutFingerprint(path);
  const sameFile = expectedFingerprint === undefined || expectedFingerprint === fingerprint;

  let range: { text: string; start: number };
  try {
    range = readRange(path, sameFile ? from : undefined);
  } catch {
    return { messages: [], offset: from ?? 0, raw: '', fingerprint: undefined };
  }
  if (range.text === '') {
    return { messages: [], offset: range.start, raw: '', fingerprint };
  }

  const lines = range.text.split('\n');
  const complete = lines.slice(0, -1);
  let consumed = 0;
  for (const line of complete) {
    consumed += Buffer.byteLength(line, 'utf8') + 1;
  }
  const raw = complete.join('\n');
  return {
    messages: parseRolloutLines(raw),
    offset: range.start + consumed,
    raw,
    fingerprint,
  };
}
