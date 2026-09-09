import {
  PublicationUnavailable,
  recallText,
  ReflectionNotStoredError,
  type Logger,
} from '@aion/core';
import {
  MemoryPackSchema,
  RecallInputSchema,
  RecallRefusalSchema,
  ReflectionInputSchema,
  ReflectionOutputSchema,
  SourceInputSchema,
  SourceOutputSchema,
  SourceSearchInputSchema,
  SourceSearchOutputSchema,
  type RecallResult,
  type ReflectionOutput,
  type SourceOutput,
  type SourceSearchOutput,
} from '@aion/protocol';
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
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
  SOURCE_DESCRIPTION,
  SOURCE_SEARCH_DESCRIPTION,
  SOURCE_SEARCH_TITLE,
  SOURCE_SEARCH_TOOL_NAME,
  SOURCE_TITLE,
  SOURCE_TOOL_NAME,
} from './descriptions.js';

/**
 * The four tools this service exposes. The wire schemas are the ones the handlers themselves
 * parse (`@aion/protocol`), converted to JSON Schema rather than restated, so a client sees
 * exactly the contract the handler enforces and the two cannot drift.
 */

type JsonObjectSchema = Tool['inputSchema'];

/**
 * `$schema` is dropped because MCP's tool schema is a JSON Schema fragment, not a document,
 * and some clients reject the meta key.
 */
function jsonSchemaFor(schema: z.ZodType, io: 'input' | 'output'): JsonObjectSchema {
  const converted = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  delete converted.$schema;
  if (converted.type !== 'object') {
    throw new Error(
      `tool schema must convert to a JSON Schema object, produced ${String(converted.type)}`,
    );
  }
  return converted as JsonObjectSchema;
}

/**
 * A result with two shapes, published as one object schema.
 *
 * A tool's output schema is a JSON Schema object, and a bare union converts to an `anyOf`
 * fragment with no `type` at all, which is not that. The branches are converted exactly as they
 * would be alone, so the successful shape a client compiles today is byte-for-byte the one it
 * compiles now, with a second permitted shape beside it.
 */
function jsonSchemaForEither(branches: readonly z.ZodType[]): JsonObjectSchema {
  return { type: 'object', anyOf: branches.map((branch) => jsonSchemaFor(branch, 'output')) };
}

const VERSION_META = { [DESCRIPTIONS_VERSION_META_KEY]: DESCRIPTIONS_VERSION } as const;

export const TOOL_DEFINITIONS: readonly Tool[] = [
  {
    name: RECALL_TOOL_NAME,
    title: RECALL_TITLE,
    description: RECALL_DESCRIPTION,
    inputSchema: jsonSchemaFor(RecallInputSchema, 'input'),
    outputSchema: jsonSchemaForEither([MemoryPackSchema, RecallRefusalSchema]),
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
  {
    name: SOURCE_SEARCH_TOOL_NAME,
    title: SOURCE_SEARCH_TITLE,
    description: SOURCE_SEARCH_DESCRIPTION,
    inputSchema: jsonSchemaFor(SourceSearchInputSchema, 'input'),
    outputSchema: jsonSchemaFor(SourceSearchOutputSchema, 'output'),
    annotations: {
      title: SOURCE_SEARCH_TITLE,
      // An explicit read: it creates no session, stamps no access, reinforces nothing and
      // queues nothing. The index behind it is maintained by its own handler.
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ...VERSION_META },
  },
  {
    name: SOURCE_TOOL_NAME,
    title: SOURCE_TITLE,
    description: SOURCE_DESCRIPTION,
    inputSchema: jsonSchemaFor(SourceInputSchema, 'input'),
    outputSchema: jsonSchemaFor(SourceOutputSchema, 'output'),
    annotations: {
      title: SOURCE_TITLE,
      readOnlyHint: true,
      destructiveHint: false,
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
  readonly recall: (args: unknown, identity: string) => Promise<RecallResult>;
  readonly reflection: (args: unknown, identity: string) => Promise<ReflectionOutput>;
  readonly sourceSearch: (args: unknown) => Promise<{ output: SourceSearchOutput; text: string }>;
  readonly source: (args: unknown) => Promise<{ output: SourceOutput; text: string }>;
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

/** The tools this service answers for, read off the definitions so the two cannot drift. */
const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * What a client needs to decide whether to send the same request again.
 *
 * `retryable` is the failure class's own answer, read off a class this module recognizes
 * rather than off any object that happens to carry the field, so an invariant or unrecognized
 * failure cannot acquire retryability by resembling a transient one.
 *
 * It says nothing about whether the experience was stored. A publication the substrate
 * accepted is durable before the graph half runs and is settled by the next publication
 * either way, so retryability answers "send it again", not "it is gone". `reason` is the
 * substrate's own short name for the failure and `operationId` is the delivery identity the
 * service log records; neither carries the payload.
 */
type PublicationErrorData = {
  readonly retryable: boolean;
  readonly reason: string;
  readonly operationId?: string;
};

function publicationErrorData(err: PublicationUnavailable): PublicationErrorData {
  return {
    retryable: err.retryable,
    reason: err.reason,
    ...(err.operationId === undefined ? {} : { operationId: err.operationId }),
  };
}

/**
 * A payload rejected by the handler's own `parse` is the caller's error and comes back as
 * invalid-params carrying the zod message. Anything else is ours: it is logged with its
 * stack and reported as an internal error naming the failure class, never the payload.
 * Tool arguments carry the conversation and never reach the log or the wire.
 *
 * One class carries its own message through: `ReflectionNotStoredError` states what
 * happened to the experience the caller just handed over, which no class name can, and an
 * agent that is not told its reflection was dropped will not send it again.
 *
 * A publication failure additionally carries its terms as structure. The class name in prose
 * was all a client had, and deciding to retry by matching that string is not a contract.
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
  const message = `${tool} failed (${name}); see the aion service log`;
  if (err instanceof PublicationUnavailable) {
    return new McpError(ErrorCode.InternalError, message, publicationErrorData(err));
  }
  return new McpError(ErrorCode.InternalError, message);
}

/**
 * Structured JSON alongside the rendered text block: a client that understands
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
  if (!TOOL_NAMES.has(name)) {
    throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
  }

  try {
    // A refusal is handled here deliberately rather than falling out as an internal error or a
    // pack with nothing in it: the request was not answered, and an empty pack says the
    // substrate looked and found nothing. Both branches carry matching text and structure.
    if (name === RECALL_TOOL_NAME) {
      const result = await backend.recall(args, identity);
      return {
        content: [{ type: 'text', text: recallText(result) }],
        structuredContent: result,
      };
    }

    // A refusal and an unavailable capability carry matching text and structured output, so a
    // client that renders only the block is told the search could not run rather than that
    // nothing matched.
    if (name === SOURCE_SEARCH_TOOL_NAME) {
      const found = await backend.sourceSearch(args);
      return { content: [{ type: 'text', text: found.text }], structuredContent: found.output };
    }

    if (name === SOURCE_TOOL_NAME) {
      const read = await backend.source(args);
      return { content: [{ type: 'text', text: read.text }], structuredContent: read.output };
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
