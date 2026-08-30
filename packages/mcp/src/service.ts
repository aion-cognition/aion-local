import type { Logger, PlasticityCounters, QueueLagSnapshot } from '@aion/core';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';

import { DESCRIPTIONS_VERSION } from './descriptions.js';
import { healthPayload } from './health.js';
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
import { buildMcpServer, InFlightCalls } from './mcp-server.js';
import { McpSessionRegistry, type McpSession } from './session-registry.js';
import type { ToolBackend } from './tools.js';

/**
 * One long-lived streamable-HTTP service multiplexing every connected agent session. Each
 * client gets its own transport, its own MCP `Server`, and its own transport session id;
 * that id is the identity `SessionManager` keys a Session node on, which is what lets many
 * concurrent sessions share one process and one substrate without sharing a memory session.
 *
 * This file is the HTTP surface: binding, routing, and the session a request belongs to.
 * Which sessions exist is `session-registry.ts`, what a tool call may do is `mcp-server.ts`,
 * and the probe body is `health.ts`. Everything expensive (the driver, the SQLite handle, the
 * session cache, the cue cache) lives in `ToolBackend` and is shared across all of them.
 */

/**
 * How long shutdown waits for tool calls already running. Compose's default `stop_grace_period`
 * is 10s before SIGKILL, and the rest of shutdown (closing sessions, the driver, SQLite) has
 * to fit in what is left, so this is deliberately shorter than a recall's own worst case. A
 * call still running at the deadline loses its socket, which is the old behaviour for every
 * call; the drain is what keeps the ordinary one from meeting it.
 */
export const DRAIN_TIMEOUT_MS = 7000;

export type AionMcpServiceOptions = {
  readonly backend: ToolBackend;
  readonly logger: Logger;
  readonly host: string;
  readonly port: number;
  /** Overridable for tests, which cannot afford to wait out the real deadline. */
  readonly drainTimeoutMs?: number;
  /**
   * The session-close boundary: the transport ended, so the session's experience is complete
   * and its narrative can be compressed. The id handed over is the transport session id,
   * which is the Session node's id. Best-effort and fire-and-forget: a hook that throws or
   * rejects never affects teardown, and a client that vanishes without a DELETE never
   * reaches it at all, which is what the idle sweep exists for.
   */
  readonly onSessionClosed?: (sessionId: string) => void;
  /**
   * `/health` used to report only `{status, sessions, descriptions_version}` while 4,000+
   * jobs sat pending. `queueLagSnapshot` (`@aion/core`) is SQLite-only, with no Neo4j and no
   * Ollama, so calling it on every liveness probe stays cheap and never touches the graph or
   * the model. Absent, the fields it would fill are simply omitted, which is what every
   * construction that predates it gets.
   */
  readonly queueLag?: () => QueueLagSnapshot;
  /**
   * Same reasoning as `queueLag`: SQLite-only, so calling it on every liveness probe never
   * touches the graph. The edge-weight distribution is graph-bound and stays out of `/health`
   * on purpose; `aion status` is where it belongs.
   */
  readonly plasticity?: () => PlasticityCounters;
};

export class AionMcpService {
  readonly #backend: ToolBackend;
  readonly #logger: Logger;
  readonly #host: string;
  readonly #configuredPort: number;
  readonly #sessions: McpSessionRegistry;
  readonly #http: HttpServer;
  readonly #queueLag: (() => QueueLagSnapshot) | undefined;
  readonly #plasticity: (() => PlasticityCounters) | undefined;
  readonly #inFlight: InFlightCalls;
  #stopping = false;

  constructor(options: AionMcpServiceOptions) {
    this.#backend = options.backend;
    this.#logger = options.logger;
    this.#host = options.host;
    this.#configuredPort = options.port;
    this.#sessions = new McpSessionRegistry(options.logger, options.onSessionClosed);
    this.#inFlight = new InFlightCalls(options.logger, options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
    this.#queueLag = options.queueLag;
    this.#plasticity = options.plasticity;
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
    return address.port;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
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
      {
        host: this.#host,
        port: this.port,
        path: MCP_PATH,
        descriptionsVersion: DESCRIPTIONS_VERSION,
      },
      'mcp service listening',
    );
    return this.port;
  }

  /**
   * A tool call in flight when compose sends SIGTERM used to have its socket destroyed
   * mid-response and then hit a closed driver pool, so the client learned nothing until its
   * own request timeout fired. Shutdown now stops the listener, lets what is running finish,
   * and only then tears the transports and sockets down.
   *
   * `closeAllConnections` follows the session close because a keep-alive socket with no
   * stream on it would otherwise hold the HTTP close callback open until the client noticed.
   */
  async close(): Promise<void> {
    const { port } = this;
    this.#stopping = true;
    await this.#inFlight.drain();
    await this.#sessions.closeAll();

    if (!this.#http.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#http.close((err) => {
        if (err === undefined) {
          resolve();
          return;
        }
        reject(err);
      });
      this.#http.closeAllConnections();
    });
    this.#logger.info({ port }, 'mcp service stopped');
  }

  /**
   * The path most sessions actually close by. A client's `close()` aborts its transport
   * locally and issues no DELETE, so waiting for the hook leaves the session open until the
   * process ends. `SessionIdleSweeper` is what puts this on a clock; `now` is a seam for the
   * tests that cannot wait one out.
   */
  closeIdleSessions(idleMs: number, now: number = Date.now()): readonly string[] {
    return this.#sessions.closeIdle(idleMs, now);
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === HEALTH_PATH && req.method === 'GET') {
        writeJson(
          res,
          200,
          healthPayload({
            sessions: this.#sessions.size,
            queueLag: this.#queueLag,
            plasticity: this.#plasticity,
          }),
        );
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
      writeJsonRpcError(
        res,
        405,
        JSONRPC_INVALID_REQUEST,
        `method not allowed: ${req.method ?? 'unknown'}`,
      );
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
      writeJsonRpcError(
        res,
        400,
        JSONRPC_PARSE_ERROR,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    const sessionId = headerValue(req, 'mcp-session-id');
    if (sessionId !== undefined) {
      const session = this.#sessions.touch(sessionId);
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
    const session = sessionId === undefined ? undefined : this.#sessions.touch(sessionId);
    if (session === undefined) {
      writeJsonRpcError(res, 404, JSONRPC_INVALID_REQUEST, 'unknown or missing session');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  async #openSession(): Promise<McpSession> {
    // `onsessioninitialized` below closes over `server`, which needs `transport` to build first.
    // eslint-disable-next-line prefer-const -- circular with transport; assigned once, below.
    let server: McpSession['server'];
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.#sessions.open(id, { transport, server, lastActivityAt: Date.now() });
      },
      onsessionclosed: (id) => {
        this.#sessions.forget(id);
      },
    });

    server = buildMcpServer(transport, {
      backend: this.#backend,
      logger: this.#logger,
      inFlight: this.#inFlight,
      isStopping: () => this.#stopping,
    });
    // `connect` takes over `transport.onclose`; the protocol's own hook is the one a caller owns.
    server.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) {
        this.#sessions.forget(id);
      }
    };

    await server.connect(transport);
    return { transport, server, lastActivityAt: Date.now() };
  }
}
