import type { Logger, PlasticityCounters, QueueLagSnapshot } from '@aion/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';

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
 * One long-lived streamable-HTTP service multiplexing every connected agent session. Each
 * client gets its own transport, its own MCP `Server`, and its own transport session id;
 * that id is the identity `SessionManager` keys a Session node on, which is what lets many
 * concurrent sessions share one process and one substrate without sharing a memory session.
 *
 * The MCP `Server` is per-connection because `Protocol.connect` takes ownership of the
 * transport it is given. Everything expensive (the driver, the SQLite handle, the session
 * cache, the cue cache) lives in `ToolBackend` and is shared across all of them.
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

/**
 * How long shutdown waits for tool calls already running. Compose's default `stop_grace_period`
 * is 10s before SIGKILL, and the rest of shutdown (closing sessions, the driver, SQLite) has
 * to fit in what is left, so this is deliberately shorter than a recall's own worst case. A
 * call still running at the deadline loses its socket, which is the old behaviour for every
 * call; the drain is what keeps the ordinary one from meeting it.
 */
export const DRAIN_TIMEOUT_MS = 7000;

type McpSession = {
  readonly transport: StreamableHTTPServerTransport;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Server is the SDK's documented escape hatch for custom request handlers; McpServer's tool API can't express the raw JSON Schema contract tools.ts builds.
  readonly server: Server;
  /** Last time this session handled a request. What `closeIdleSessions` measures against. */
  lastActivityAt: number;
};

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
  readonly #sessions = new Map<string, McpSession>();
  readonly #http: HttpServer;
  readonly #drainTimeoutMs: number;
  readonly #onSessionClosed: ((sessionId: string) => void) | undefined;
  readonly #queueLag: (() => QueueLagSnapshot) | undefined;
  readonly #plasticity: (() => PlasticityCounters) | undefined;
  /** Tool calls that have started and not yet settled. Shutdown waits on these. */
  readonly #inFlight = new Set<Promise<unknown>>();
  #stopping = false;

  constructor(options: AionMcpServiceOptions) {
    this.#backend = options.backend;
    this.#logger = options.logger;
    this.#host = options.host;
    this.#configuredPort = options.port;
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    this.#onSessionClosed = options.onSessionClosed;
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
   * Resolves once every tool call running at the moment shutdown began has settled, or once
   * the deadline passes, whichever comes first. Calls that arrive while draining are refused
   * rather than admitted, so the set cannot keep refilling.
   */
  async #drain(): Promise<void> {
    if (this.#inFlight.size === 0) {
      return;
    }
    this.#logger.info({ inFlight: this.#inFlight.size }, 'mcp service draining tool calls');
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, this.#drainTimeoutMs);
      timer.unref();
    });
    try {
      const settled = Promise.allSettled([...this.#inFlight]).then(() => 'drained' as const);
      const outcome = await Promise.race([settled, deadline]);
      if (outcome === 'timeout') {
        this.#logger.warn(
          { inFlight: this.#inFlight.size, timeoutMs: this.#drainTimeoutMs },
          'mcp service drain timed out; remaining tool calls lose their connection',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A tool call in flight when compose sends SIGTERM used to have its socket destroyed
   * mid-response and then hit a closed driver pool, so the client learned nothing until its
   * own request timeout fired. Shutdown now stops the listener, lets what is running finish,
   * and only then tears the transports and sockets down.
   *
   * Closing each MCP server closes the transport it owns, which ends that client's SSE
   * stream. `closeAllConnections` follows because a keep-alive socket with no stream on it
   * would otherwise hold the HTTP close callback open until the client noticed.
   */
  async close(): Promise<void> {
    const { port } = this;
    this.#stopping = true;
    await this.#drain();

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
   * Flat, snake_case keys alongside `/health`'s existing ones. Depth is per lane rather
   * than a bare total, since a starved interactive lane behind a bulk flood and an
   * evenly-loaded queue report the same total but need opposite responses.
   */
  #queueLagFields(): Record<string, unknown> {
    if (this.#queueLag === undefined) {
      return {};
    }
    const snapshot = this.#queueLag();
    return {
      queue_depth: snapshot.depthByLane,
      queue_oldest_unclaimed_ms: snapshot.oldestUnclaimedMs ?? null,
      queue_exhausted: snapshot.exhausted,
      reinforcement_dropped: snapshot.reinforcementDropped,
      enrichment_lag_p95_ms: snapshot.p95EnrichmentLagMs ?? null,
      cue_degraded_rate: snapshot.cueDegradedRate ?? null,
      supersession_proposals_open: snapshot.supersessionProposalsOpen,
      entity_merge_proposals_open: snapshot.entityMergeProposalsOpen,
    };
  }

  /**
   * Reinforcement and decay counters plus the reinforcement queue depth; no edge-weight
   * distribution (see `plasticity` above). `reinforcement_dropped` is not repeated here: it is
   * already one of `#queueLagFields`'s keys, read from the same counter.
   */
  #plasticityFields(): Record<string, unknown> {
    if (this.#plasticity === undefined) {
      return {};
    }
    const counters = this.#plasticity();
    return {
      reinforcement_signals_applied: counters.reinforcement.signalsApplied,
      reinforcement_pairs_applied: counters.reinforcement.pairsApplied,
      reinforcement_edges_updated: counters.reinforcement.edgesUpdated,
      reinforcement_last_run_at: counters.reinforcement.lastRunAt ?? null,
      reinforcement_queue_depth: counters.reinforcementQueueDepth,
      decay_edges_scanned: counters.decay.edgesScanned,
      decay_edges_decayed: counters.decay.edgesDecayed,
      decay_last_run_at: counters.decay.lastRunAt ?? null,
    };
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === HEALTH_PATH && req.method === 'GET') {
        writeJson(res, 200, {
          status: 'ok',
          sessions: this.#sessions.size,
          descriptions_version: DESCRIPTIONS_VERSION,
          build_sha: process.env.AION_BUILD_SHA ?? 'unstamped',
          ...this.#queueLagFields(),
          ...this.#plasticityFields(),
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
    // `onsessioninitialized` below closes over `server`, which needs `transport` to build first.
    // eslint-disable-next-line prefer-const -- circular with transport; assigned once, below.
    let server: McpSession['server'];
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.#sessions.set(id, { transport, server, lastActivityAt: Date.now() });
        this.#logger.info({ sessionId: id, sessions: this.#sessions.size }, 'mcp session opened');
        this.#evictOverflow();
      },
      onsessionclosed: (id) => {
        this.#forget(id);
      },
    });

    server = this.#buildServer(transport);
    // `connect` takes over `transport.onclose`; the protocol's own hook is the one a caller owns.
    server.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) {
        this.#forget(id);
      }
    };

    await server.connect(transport);
    return { transport, server, lastActivityAt: Date.now() };
  }

  /** Re-inserting keeps the map in least-recently-used order, which is what `#evictOverflow` reads. */
  #touch(sessionId: string): McpSession | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    this.#sessions.delete(sessionId);
    session.lastActivityAt = Date.now();
    this.#sessions.set(sessionId, session);
    return session;
  }

  /**
   * The path most sessions actually close by. A client's `close()` aborts its transport
   * locally and issues no DELETE, so waiting for the hook leaves the session open until the
   * process ends: a session past `idleMs` since its
   * last request closes the way a DELETE
   * would (`session.server.close()` runs the same transport-close chain `#forget` reaches
   * from), independent of whether the client ever sends one. `SessionIdleSweeper` is what
   * puts this on a clock; this method only decides which sessions qualify at the given
   * instant, which is what keeps it a synchronous, deterministic thing to test.
   */
  closeIdleSessions(idleMs: number, now: number = Date.now()): readonly string[] {
    const cutoff = now - idleMs;
    const closed: string[] = [];
    for (const [sessionId, session] of this.#sessions) {
      if (session.lastActivityAt > cutoff) {
        continue;
      }
      closed.push(sessionId);
      this.#logger.info({ sessionId, idleMs }, 'mcp session idle-expired');
      void session.server.close().catch((err: unknown) => {
        this.#logger.warn({ err, sessionId }, 'mcp session close failed');
      });
    }
    return closed;
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

  /** The tracked promise never rejects, so registering it cannot produce an unhandled rejection. */
  async #track<T>(call: Promise<T>): Promise<T> {
    const tracked = call.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlight.add(tracked);
    try {
      return await call;
    } finally {
      this.#inFlight.delete(tracked);
    }
  }

  #forget(sessionId: string): void {
    if (!this.#sessions.delete(sessionId)) {
      return;
    }
    this.#logger.info({ sessionId, sessions: this.#sessions.size }, 'mcp session closed');
    if (this.#onSessionClosed === undefined) {
      return;
    }
    // Teardown is not the hook's to fail: a close that threw would leave the transport half
    // dismantled over work that is recoverable by the idle sweep anyway.
    try {
      this.#onSessionClosed(sessionId);
    } catch (err) {
      this.#logger.error({ err, sessionId }, 'session close hook failed');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Server is the SDK's documented escape hatch for custom request handlers; McpServer's tool API can't express the raw JSON Schema contract tools.ts builds.
  #buildServer(transport: StreamableHTTPServerTransport): Server {
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
      if (this.#stopping) {
        throw new McpError(
          ErrorCode.InternalError,
          'aion-mcp is shutting down; retry once it is back',
        );
      }
      return this.#track(
        callTool(
          this.#backend,
          this.#logger,
          request.params.name,
          request.params.arguments,
          identity,
        ),
      );
    });

    return server;
  }
}
