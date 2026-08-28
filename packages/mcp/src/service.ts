import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@aion/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { DESCRIPTIONS_VERSION, USAGE_PROTOCOL } from './descriptions.js';
import {
  HEALTH_PATH,
  headerValue,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  MCP_PATH,
  readJsonBody,
  writeJson,
  writeJsonRpcError,
} from './http.js';
import { callTool, TOOL_DEFINITIONS, type ToolBackend } from './tools.js';

/**
 * PRD §3.3, §4: one long-lived streamable-HTTP service multiplexing every connected agent
 * session. Each client gets its own transport, its own MCP `Server`, and its own transport
 * session id; that id is the identity `SessionManager` keys a Session node on, which is
 * what lets many concurrent sessions share one process and one substrate without sharing a
 * memory session.
 *
 * The MCP `Server` is per-connection because `Protocol.connect` takes ownership of the
 * transport it is given. Everything expensive — the driver, the SQLite handle, the session
 * cache, the cue cache — lives in `ToolBackend` and is shared across all of them.
 */

const SERVER_INFO = { name: 'aion', version: '0.0.0' } as const;

/**
 * A client that disconnects without a DELETE leaves its session behind, and the service
 * outlives every session it serves, so the map is held to a ceiling and evicted
 * least-recently-used. Reaching it means hundreds of live sessions at once, which no
 * single-user stack does; an evicted client sees its next call answered with 404 and
 * reconnects.
 */
const MAX_SESSIONS = 512;

type McpSession = {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Server;
};

export type AionMcpServiceOptions = {
  readonly backend: ToolBackend;
  readonly logger: Logger;
  readonly host: string;
  readonly port: number;
};

export class AionMcpService {
  readonly #backend: ToolBackend;
  readonly #logger: Logger;
  readonly #host: string;
  readonly #configuredPort: number;
  readonly #sessions = new Map<string, McpSession>();
  readonly #http: HttpServer;

  constructor(options: AionMcpServiceOptions) {
    this.#backend = options.backend;
    this.#logger = options.logger;
    this.#host = options.host;
    this.#configuredPort = options.port;
    this.#http = createServer((req, res) => {
      void this.#route(req, res);
    });
  }

  /** The port actually bound, which is the configured one unless 0 asked the OS to choose. */
  get port(): number {
    const address = this.#http.address();
    if (address === null || typeof address === 'string') {
      return this.#configuredPort;
    }
    return (address as AddressInfo).port;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(err);
      };
      this.#http.once('error', onError);
      this.#http.listen(this.#configuredPort, this.#host, () => {
        this.#http.off('error', onError);
        resolve();
      });
    });
    this.#logger.info(
      { host: this.#host, port: this.port, path: MCP_PATH, descriptionsVersion: DESCRIPTIONS_VERSION },
      'mcp service listening',
    );
    return this.port;
  }

  /**
   * Closing each MCP server closes the transport it owns, which ends that client's SSE
   * stream. `closeAllConnections` follows because a keep-alive socket with no stream on it
   * would otherwise hold the HTTP close callback open until the client noticed.
   */
  async close(): Promise<void> {
    const port = this.port;
    for (const session of [...this.#sessions.values()]) {
      try {
        await session.server.close();
      } catch (err) {
        this.#logger.warn({ err }, 'mcp session close failed');
      }
    }
    this.#sessions.clear();

    if (!this.#http.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#http.close((err) => {
        if (err === undefined || err === null) {
          resolve();
          return;
        }
        reject(err);
      });
      this.#http.closeAllConnections();
    });
    this.#logger.info({ port }, 'mcp service stopped');
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === HEALTH_PATH && req.method === 'GET') {
        writeJson(res, 200, {
          status: 'ok',
          sessions: this.#sessions.size,
          descriptions_version: DESCRIPTIONS_VERSION,
        });
        return;
      }
      if (path !== MCP_PATH) {
        writeJson(res, 404, { error: `not found: ${path}` });
        return;
      }
      if (req.method === 'POST') {
        await this.#post(req, res);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        await this.#existingSession(req, res);
        return;
      }
      writeJsonRpcError(res, 405, JSONRPC_INVALID_REQUEST, `method not allowed: ${req.method ?? 'unknown'}`);
    } catch (err) {
      this.#logger.error({ err, method: req.method }, 'mcp request failed');
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, ErrorCode.InternalError, 'internal error');
        return;
      }
      res.end();
    }
  }

  async #post(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJsonRpcError(res, 400, JSONRPC_PARSE_ERROR, err instanceof Error ? err.message : String(err));
      return;
    }

    const sessionId = headerValue(req, 'mcp-session-id');
    if (sessionId !== undefined) {
      const session = this.#touch(sessionId);
      if (session === undefined) {
        writeJsonRpcError(res, 404, JSONRPC_INVALID_REQUEST, `unknown session: ${sessionId}`);
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      writeJsonRpcError(
        res,
        400,
        JSONRPC_INVALID_REQUEST,
        'missing mcp-session-id header; only an initialize request may open a session',
      );
      return;
    }

    const session = await this.#openSession();
    await session.transport.handleRequest(req, res, body);
  }

  /** GET (the notification stream) and DELETE (session teardown) carry no body and require a live session. */
  async #existingSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerValue(req, 'mcp-session-id');
    const session = sessionId === undefined ? undefined : this.#touch(sessionId);
    if (session === undefined) {
      writeJsonRpcError(res, 404, JSONRPC_INVALID_REQUEST, 'unknown or missing session');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  async #openSession(): Promise<McpSession> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.#sessions.set(id, { transport, server });
        this.#logger.info({ sessionId: id, sessions: this.#sessions.size }, 'mcp session opened');
        this.#evictOverflow();
      },
      onsessionclosed: (id) => {
        this.#forget(id);
      },
    });

    const server = this.#buildServer(transport);
    // `connect` takes over `transport.onclose`; the protocol's own hook is the one a caller owns.
    server.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) {
        this.#forget(id);
      }
    };

    await server.connect(transport);
    return { transport, server };
  }

  /** Re-inserting keeps the map in least-recently-used order, which is what `#evictOverflow` reads. */
  #touch(sessionId: string): McpSession | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    this.#sessions.delete(sessionId);
    this.#sessions.set(sessionId, session);
    return session;
  }

  #evictOverflow(): void {
    while (this.#sessions.size > MAX_SESSIONS) {
      const oldest = this.#sessions.entries().next().value;
      if (oldest === undefined) {
        return;
      }
      const [sessionId, session] = oldest;
      this.#sessions.delete(sessionId);
      this.#logger.warn({ sessionId, sessions: this.#sessions.size }, 'mcp session evicted');
      void session.server.close().catch((err: unknown) => {
        this.#logger.warn({ err, sessionId }, 'mcp session close failed');
      });
    }
  }

  #forget(sessionId: string): void {
    if (this.#sessions.delete(sessionId)) {
      this.#logger.info({ sessionId, sessions: this.#sessions.size }, 'mcp session closed');
    }
  }

  #buildServer(transport: StreamableHTTPServerTransport): Server {
    const server = new Server(SERVER_INFO, {
      capabilities: { tools: {} },
      instructions: USAGE_PROTOCOL,
    });

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOL_DEFINITIONS] }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const identity = extra.sessionId ?? transport.sessionId;
      if (identity === undefined) {
        throw new McpError(ErrorCode.InternalError, 'tool call arrived without a transport session id');
      }
      return callTool(
        this.#backend,
        this.#logger,
        request.params.name,
        request.params.arguments,
        identity,
      );
    });

    return server;
  }
}
