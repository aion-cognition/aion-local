import { isRecord } from './mcp.js';
import type { BufferedTool } from './state.js';
import type { TranscriptMessage } from './transcript.js';

/** Wire shaping for both directions: what the harness hands the hook, and what the hook hands the tools. */

/** The pack buckets. A pack with none of them holds nothing worth injecting, whatever its rendered text says. */
const PACK_BUCKETS = ['facts', 'episodes', 'narratives', 'preferences', 'resonant'] as const;

/** A tool result excerpt past this is noise for reflection and cost on the wire. */
export const TOOL_OUTPUT_LIMIT = 2000;

/** The arguments summary is a locator, not the call. */
export const TOOL_INPUT_LIMIT = 1000;

export function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A missing flag is false. The Stop loop guard depends on that reading, not on an error. */
export function booleanField(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}

/** Exit 0 plus this line on stdout is how a hook injects context; anything else on stdout is ignored. */
export function additionalContext(hookEventName: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

export function packHasContent(structured: Record<string, unknown> | undefined): boolean {
  if (structured === undefined) {
    return false;
  }
  return PACK_BUCKETS.some((bucket) => {
    const entries = structured[bucket];
    return Array.isArray(entries) && entries.length > 0;
  });
}

export function packText(
  structured: Record<string, unknown> | undefined,
  fallback: string | undefined,
): string | undefined {
  if (structured !== undefined && typeof structured.rendered_text === 'string') {
    return structured.rendered_text;
  }
  return fallback;
}

export function recallArgs(
  query: string,
  maxTokens: number,
  sessionId: string | undefined,
): Record<string, unknown> {
  const args: Record<string, unknown> = { query, budget: { max_tokens: maxTokens } };
  if (sessionId !== undefined) {
    args.session_id = sessionId;
  }
  return args;
}

export type ReflectionTurnPayload = {
  readonly role: string;
  readonly text: string;
  readonly occurred_at?: string;
};

export function reflectionTurns(
  messages: readonly TranscriptMessage[],
): readonly ReflectionTurnPayload[] {
  return messages.map((message) => {
    if (message.occurredAt === undefined) {
      return { role: message.role, text: message.text };
    }
    return { role: message.role, text: message.text, occurred_at: message.occurredAt };
  });
}

export type ToolExecutionPayload = {
  readonly tool: string;
  readonly status: string;
  readonly input?: string;
  readonly output?: string;
  readonly occurred_at?: string;
};

export function toolExecutions(buffered: readonly BufferedTool[]): readonly ToolExecutionPayload[] {
  return buffered.map((record) => {
    const payload: Record<string, unknown> = { tool: record.tool, status: record.status };
    if (record.input !== '') {
      payload.input = record.input;
    }
    if (record.output !== '') {
      payload.output = record.output;
    }
    if (record.occurredAt !== '') {
      payload.occurred_at = record.occurredAt;
    }
    return payload as ToolExecutionPayload;
  });
}

/**
 * The hook subtree imports node builtins and its own siblings only (`imports.test.ts`), so
 * this names the one channel a hook fire can ever claim rather than importing the protocol's
 * enum for it.
 */
export type ReflectionOriginPayload = {
  readonly channel: 'hook';
  readonly event: string;
};

export function reflectionArgs(
  turns: readonly ReflectionTurnPayload[],
  executions: readonly ToolExecutionPayload[],
  sessionId: string | undefined,
  origin: ReflectionOriginPayload,
): Record<string, unknown> {
  const args: Record<string, unknown> = { origin };
  if (turns.length > 0) {
    args.turns = turns;
  }
  if (executions.length > 0) {
    args.tool_executions = executions;
  }
  if (sessionId !== undefined) {
    args.session_id = sessionId;
  }
  return args;
}

function excerpt(value: unknown, limit: number): string {
  if (value === undefined || value === null) {
    return '';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') {
    return '';
  }
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * The harness reports a failed tool call in the result body rather than out of band, so the
 * status is read off the shape it hands over.
 */
function toolStatus(response: unknown): string {
  if (isRecord(response) && (response.is_error === true || response.error !== undefined)) {
    return 'error';
  }
  return 'ok';
}

export function bufferedToolFrom(
  input: Record<string, unknown>,
  occurredAt: string,
): BufferedTool | undefined {
  const tool = stringField(input, 'tool_name');
  if (tool === undefined) {
    return undefined;
  }
  const response = input.tool_response ?? input.tool_result;
  return {
    tool,
    input: excerpt(input.tool_input, TOOL_INPUT_LIMIT),
    output: excerpt(response, TOOL_OUTPUT_LIMIT),
    status: toolStatus(response),
    occurredAt,
  };
}
