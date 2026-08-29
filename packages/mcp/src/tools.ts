import { ReflectionNotStoredError, type Logger } from '@aion/core';
import {
  MemoryPackSchema,
  RecallInputSchema,
  ReflectionInputSchema,
  ReflectionOutputSchema,
  type RecallOutput,
  type ReflectionOutput,
} from '@aion/protocol';
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  DESCRIPTIONS_VERSION,
  DESCRIPTIONS_VERSION_META_KEY,
  RECALL_DESCRIPTION,
  RECALL_TITLE,
  RECALL_TOOL_NAME,
  REFLECTION_DESCRIPTION,
  REFLECTION_TITLE,
  REFLECTION_TOOL_NAME,
} from './descriptions.js';

/**
 * PRD §3.1–3.2's two tools. The wire schemas are the ones the handlers themselves parse
 * (`@aion/protocol`), converted to JSON Schema rather than restated, so a client sees
 * exactly the contract the handler enforces and the two cannot drift.
 */

type JsonObjectSchema = Tool['inputSchema'];

/**
 * `$schema` is dropped because MCP's tool schema is a JSON Schema fragment, not a document,
 * and some clients reject the meta key.
 */
function jsonSchemaFor(schema: z.ZodType, io: 'input' | 'output'): JsonObjectSchema {
  const converted = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  delete converted['$schema'];
  if (converted['type'] !== 'object') {
    throw new Error(`tool schema must convert to a JSON Schema object, produced ${String(converted['type'])}`);
  }
  return converted as JsonObjectSchema;
}

const VERSION_META = { [DESCRIPTIONS_VERSION_META_KEY]: DESCRIPTIONS_VERSION } as const;

export const TOOL_DEFINITIONS: readonly Tool[] = [
  {
    name: RECALL_TOOL_NAME,
    title: RECALL_TITLE,
    description: RECALL_DESCRIPTION,
    inputSchema: jsonSchemaFor(RecallInputSchema, 'input'),
    outputSchema: jsonSchemaFor(MemoryPackSchema, 'output'),
    annotations: {
      title: RECALL_TITLE,
      // Recall writes access metadata and reinforcement signals, so it is not read-only,
      // but nothing it writes is visible to the caller or removable by it.
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: { ...VERSION_META },
  },
  {
    name: REFLECTION_TOOL_NAME,
    title: REFLECTION_TITLE,
    description: REFLECTION_DESCRIPTION,
    inputSchema: jsonSchemaFor(ReflectionInputSchema, 'input'),
    outputSchema: jsonSchemaFor(ReflectionOutputSchema, 'output'),
    annotations: {
      title: REFLECTION_TITLE,
      readOnlyHint: false,
      destructiveHint: false,
      // Content-hash dedupe: the same payload twice resolves to the one episode.
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ...VERSION_META },
  },
];

/**
 * The seam between the transport and the two core handlers. The service binds these to
 * `handleRecall` / `handleReflection` over the process-wide deps; tests bind them to
 * whatever they need to observe.
 */
export type ToolBackend = {
  readonly recall: (args: unknown, identity: string) => Promise<RecallOutput>;
  readonly reflection: (args: unknown, identity: string) => Promise<ReflectionOutput>;
};

/**
 * The lane is named in the text and not only in `structuredContent`: a client that reads the
 * rendered block alone would otherwise never learn that its episode was demoted behind a
 * bulk load, which is the one thing the ack exists to tell it. `pending_ahead` follows the
 * same reasoning: a text-only client is exactly the one with no other way to see how
 * far behind live traffic its own memory queued.
 */
function ackText(output: ReflectionOutput): string {
  const base = `Stored episode ${output.episode_id}; queued for reflection (${output.lane} lane).`;
  if (output.pending_ahead === undefined || output.pending_ahead === 0) {
    return base;
  }
  const jobs = output.pending_ahead === 1 ? 'job' : 'jobs';
  return `${base} ${String(output.pending_ahead)} interactive ${jobs} ahead of it.`;
}

/**
 * A payload rejected by the handler's own `parse` is the caller's error and comes back as
 * invalid-params carrying the zod message. Anything else is ours: it is logged with its
 * stack and reported as an internal error naming the failure class, never the payload —
 * tool arguments carry the conversation and never reach the log or the wire.
 *
 * One class carries its own message through: `ReflectionNotStoredError` states what
 * happened to the experience the caller just handed over, which no class name can, and an
 * agent that is not told its reflection was dropped will not send it again.
 */
function toMcpError(tool: string, err: unknown, logger: Logger): McpError {
  if (err instanceof z.ZodError) {
    return new McpError(ErrorCode.InvalidParams, `${tool}: ${z.prettifyError(err)}`);
  }
  logger.error({ err, tool }, 'tool call failed');
  if (err instanceof ReflectionNotStoredError) {
    return new McpError(ErrorCode.InternalError, err.message);
  }
  const name = err instanceof Error ? err.name : typeof err;
  return new McpError(ErrorCode.InternalError, `${tool} failed (${name}); see the aion service log`);
}

/**
 * Structured JSON alongside the rendered text block (PRD §3.1): a client that understands
 * `structuredContent` gets the pack with its rationale intact, and one that only renders
 * text still gets something the agent can drop into its reasoning.
 */
export async function callTool(
  backend: ToolBackend,
  logger: Logger,
  name: string,
  args: unknown,
  identity: string,
): Promise<CallToolResult> {
  if (name !== RECALL_TOOL_NAME && name !== REFLECTION_TOOL_NAME) {
    throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
  }

  try {
    if (name === RECALL_TOOL_NAME) {
      const pack = await backend.recall(args, identity);
      return {
        content: [{ type: 'text', text: pack.rendered_text }],
        structuredContent: pack,
      };
    }

    const stored = await backend.reflection(args, identity);
    return {
      content: [{ type: 'text', text: ackText(stored) }],
      structuredContent: stored,
    };
  } catch (err) {
    throw toMcpError(name, err, logger);
  }
}
