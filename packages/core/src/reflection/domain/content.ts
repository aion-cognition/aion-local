import type { ReflectionInput, ReflectionTurn, ToolExecution } from '@aion/protocol';
import { createHash } from 'node:crypto';

/**
 * The payload minus its routing fields. `session_id` never reaches content assembly or the
 * content hash: the same experience pushed under two identities is two episodes because
 * the dedupe window is the session, not because the hash differs. `lane` is scheduling, and
 * the same experience is the same experience whichever queue it waited in.
 */
export type ReflectionContent = Omit<ReflectionInput, 'session_id' | 'lane' | 'origin'>;

export type PreparedTurn = {
  readonly role: string;
  readonly text: string;
  readonly sequence: number;
  readonly contentHash: string;
  readonly occurredAt: Date;
};

export type PreparedEpisode = {
  readonly text: string;
  readonly summary: string | undefined;
  readonly contentHash: string;
  readonly occurredAt: Date;
  readonly turns: readonly PreparedTurn[];
  readonly turnCount: number;
  readonly toolExecutionCount: number;
  readonly observationCount: number;
};

/**
 * Object keys sorted at every depth so two payloads that differ only in key order hash
 * identically. `tool_executions[].input`/`output` are arbitrary JSON, which is the shape
 * that makes source key order otherwise leak into the hash.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        out[key] = canonical(source[key]);
      }
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  // lib.es5 types JSON.stringify as always returning `string`, and TS trusts that over a
  // local cast or widening annotation. At runtime it returns `undefined` for a value JSON
  // cannot represent, which the fallback covers with the JSON-shaped "null" rather than
  // the string "undefined".
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see comment above
  return JSON.stringify(canonical(value)) ?? 'null';
}

export function hashContent(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** Strings pass through; structured tool input/output serializes canonically. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return stableStringify(value);
}

/** What the agent did not capture is left out, not rendered as an empty line or "undefined". */
function renderToolExecution(execution: ToolExecution): string[] {
  const duration =
    execution.duration_ms === undefined ? '' : `, ${String(execution.duration_ms)}ms`;
  const lines = [`tool ${execution.tool} [${execution.status}${duration}]`];

  if (execution.input !== undefined) {
    lines.push(`input: ${renderValue(execution.input)}`);
  }
  if (execution.output !== undefined) {
    lines.push(`output: ${renderValue(execution.output)}`);
  }

  return lines;
}

/**
 * Tool executions and observations are episode content, not node types of their own.
 * Assembly is a fixed-order structural render, with no summarizing and no keyword work,
 * because everything the episode text is for downstream (embedding, fulltext, extraction)
 * routes to inference in the reflection pipeline.
 */
export function renderEpisodeText(content: ReflectionContent): string {
  const lines: string[] = [];

  if (content.summary !== undefined) {
    lines.push(`summary: ${content.summary}`);
  }
  for (const turn of content.turns ?? []) {
    lines.push(`${turn.role}: ${turn.text}`);
  }
  for (const execution of content.tool_executions ?? []) {
    lines.push(...renderToolExecution(execution));
  }
  for (const observation of content.observations ?? []) {
    lines.push(`observation: ${observation}`);
  }

  return lines.join('\n');
}

function parseTimestamp(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The episode happened when the earliest thing in it happened. A payload with no
 * timestamps at all is stamped at the wall clock, which is the intake moment.
 */
function earliestOccurredAt(content: ReflectionContent, fallback: Date): Date {
  const stamps = [
    ...(content.turns ?? []).map((turn) => parseTimestamp(turn.occurred_at)),
    ...(content.tool_executions ?? []).map((execution) => parseTimestamp(execution.occurred_at)),
  ].filter((stamp): stamp is Date => stamp !== undefined);

  if (stamps.length === 0) {
    return fallback;
  }
  return stamps.reduce((earliest, stamp) => (stamp < earliest ? stamp : earliest));
}

function prepareTurn(
  turn: ReflectionTurn,
  sequence: number,
  episodeOccurredAt: Date,
): PreparedTurn {
  return {
    role: turn.role,
    text: turn.text,
    sequence,
    contentHash: hashContent(turn),
    occurredAt: parseTimestamp(turn.occurred_at) ?? episodeOccurredAt,
  };
}

/**
 * Everything a write needs, derived from the already-redacted payload with no I/O, so the
 * shape that lands in the graph is assertable without a server and the content hash is a
 * pure function of what will actually be stored.
 */
export function prepareEpisode(content: ReflectionContent, now: Date): PreparedEpisode {
  const occurredAt = earliestOccurredAt(content, now);
  const turns = (content.turns ?? []).map((turn, index) => prepareTurn(turn, index, occurredAt));

  return {
    text: renderEpisodeText(content),
    summary: content.summary,
    contentHash: hashContent(content),
    occurredAt,
    turns,
    turnCount: turns.length,
    toolExecutionCount: content.tool_executions?.length ?? 0,
    observationCount: content.observations?.length ?? 0,
  };
}
