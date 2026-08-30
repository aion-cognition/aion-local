import type { Logger } from '@aion/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { USAGE_PROTOCOL } from './descriptions.js';
import { callTool, TOOL_DEFINITIONS, type ToolBackend } from './tools.js';

/**
 * One connected agent's MCP `Server` and the tool calls it admits. The `Server` is
 * per-connection because `Protocol.connect` takes ownership of the transport it is given, so
 * the only state shared across connections is what is passed in: the backend, the logger, and
 * the in-flight set shutdown drains.
 */

const SERVER_INFO = { name: 'aion', version: '0.0.0' } as const;

/** Tool calls that have started and not yet settled. Shutdown waits on these. */
export class InFlightCalls {
  readonly #calls = new Set<Promise<unknown>>();
  readonly #logger: Logger;
  readonly #timeoutMs: number;

  constructor(logger: Logger, timeoutMs: number) {
    this.#logger = logger;
    this.#timeoutMs = timeoutMs;
  }

  get size(): number {
    return this.#calls.size;
  }

  /** The tracked promise never rejects, so registering it cannot produce an unhandled rejection. */
  async track<T>(call: Promise<T>): Promise<T> {
    const tracked = call.then(
      () => undefined,
      () => undefined,
    );
    this.#calls.add(tracked);
    try {
      return await call;
    } finally {
      this.#calls.delete(tracked);
    }
  }

  /**
   * Resolves once every tool call running at the moment shutdown began has settled, or once
   * the deadline passes, whichever comes first. Calls that arrive while draining are refused
   * rather than admitted, so the set cannot keep refilling.
   */
  async drain(): Promise<void> {
    if (this.#calls.size === 0) {
      return;
    }
    this.#logger.info({ inFlight: this.#calls.size }, 'mcp service draining tool calls');
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, this.#timeoutMs);
      timer.unref();
    });
    try {
      const settled = Promise.allSettled([...this.#calls]).then(() => 'drained' as const);
      const outcome = await Promise.race([settled, deadline]);
      if (outcome === 'timeout') {
        this.#logger.warn(
          { inFlight: this.#calls.size, timeoutMs: this.#timeoutMs },
          'mcp service drain timed out; remaining tool calls lose their connection',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export type ToolCallContext = {
  readonly backend: ToolBackend;
  readonly logger: Logger;
  readonly inFlight: InFlightCalls;
  /** Read per call rather than captured: a server built before shutdown must still see it begin. */
  readonly isStopping: () => boolean;
};

export function buildMcpServer(
  transport: StreamableHTTPServerTransport,
  context: ToolCallContext,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Server is the SDK's documented escape hatch for custom request handlers; McpServer's tool API can't express the raw JSON Schema contract tools.ts builds.
): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- same escape hatch as the return type above.
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: USAGE_PROTOCOL,
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOL_DEFINITIONS] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const identity = extra.sessionId ?? transport.sessionId;
    if (identity === undefined) {
      throw new McpError(
        ErrorCode.InternalError,
        'tool call arrived without a transport session id',
      );
    }
    // Refused rather than started: the substrate this call would touch is about to close,
    // and a named error now beats a socket that dies mid-response.
    if (context.isStopping()) {
      throw new McpError(
        ErrorCode.InternalError,
        'aion-mcp is shutting down; retry once it is back',
      );
    }
    return context.inFlight.track(
      callTool(
        context.backend,
        context.logger,
        request.params.name,
        request.params.arguments,
        identity,
      ),
    );
  });

  return server;
}
