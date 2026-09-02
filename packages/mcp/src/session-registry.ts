import type { Logger } from '@aion/core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * The live sessions, keyed by the transport session id that `SessionManager` also keys a
 * Session node on. Nothing here talks HTTP: the registry only decides which sessions exist,
 * which one a request belongs to, and which ones have earned a close, which is what keeps
 * every one of those decisions synchronous and deterministic to test.
 */

/**
 * A client that disconnects without a DELETE leaves its session behind, and the service
 * outlives every session it serves, so the map is held to a ceiling and evicted
 * least-recently-used. Reaching it means hundreds of live sessions at once, which no
 * single-user stack does; an evicted client sees its next call answered with 404 and
 * reconnects.
 */
const MAX_SESSIONS = 512;

export type McpSession = {
  readonly transport: StreamableHTTPServerTransport;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Server is the SDK's documented escape hatch for custom request handlers; McpServer's tool API can't express the raw JSON Schema contract tools.ts builds.
  readonly server: Server;
  /** Last time this session handled a request. What `closeIdle` measures against. */
  lastActivityAt: number;
};

export class McpSessionRegistry {
  readonly #sessions = new Map<string, McpSession>();
  readonly #logger: Logger;
  readonly #onSessionClosed: ((sessionId: string) => void) | undefined;

  constructor(logger: Logger, onSessionClosed: ((sessionId: string) => void) | undefined) {
    this.#logger = logger;
    this.#onSessionClosed = onSessionClosed;
  }

  get size(): number {
    return this.#sessions.size;
  }

  open(sessionId: string, session: McpSession): void {
    this.#sessions.set(sessionId, session);
    this.#logger.info({ sessionId, sessions: this.#sessions.size }, 'mcp session opened');
    this.#evictOverflow();
  }

  /** Re-inserting keeps the map in least-recently-used order, which is what `#evictOverflow` reads. */
  touch(sessionId: string): McpSession | undefined {
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
   * A session past `idleMs` since its last request closes the way a DELETE would
   * (`session.server.close()` runs the same transport-close chain `forget` reaches from),
   * independent of whether the client ever sends one. Only which sessions qualify at the given
   * instant is decided here; the close itself is left to run on its own.
   */
  closeIdle(idleMs: number, now: number): readonly string[] {
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

  /**
   * Closing each MCP server closes the transport it owns, which ends that client's SSE stream.
   * The map is dropped afterwards rather than session by session, since shutdown has no live
   * sessions left to route to.
   */
  async closeAll(): Promise<void> {
    for (const session of [...this.#sessions.values()]) {
      try {
        await session.server.close();
      } catch (err) {
        this.#logger.warn({ err }, 'mcp session close failed');
      }
    }
    this.#sessions.clear();
  }

  forget(sessionId: string): void {
    if (!this.#sessions.delete(sessionId)) {
      return;
    }
    this.#logger.info({ sessionId, sessions: this.#sessions.size }, 'mcp session closed');
    this.#runSessionClosedHook(sessionId);
  }

  // Teardown is not the hook's to fail: a close that threw would leave the transport half
  // dismantled over work that is recoverable by the idle sweep anyway.
  #runSessionClosedHook(sessionId: string): void {
    if (this.#onSessionClosed === undefined) {
      return;
    }
    try {
      this.#onSessionClosed(sessionId);
    } catch (err) {
      this.#logger.error({ err, sessionId }, 'session close hook failed');
    }
  }

  /**
   * The map has to shrink here, synchronously, for the while loop to terminate on the next
   * oldest entry rather than the one just evicted; `server.close()`'s own `onclose` still runs
   * and calls `forget`, which is now a no-op since the id is already gone. The served-items and
   * narrative cleanup that `forget` would otherwise have run is fired here instead, so an
   * evicted session gets the same teardown a DELETE or an idle close gets.
   */
  #evictOverflow(): void {
    while (this.#sessions.size > MAX_SESSIONS) {
      const oldest = this.#sessions.entries().next().value;
      if (oldest === undefined) {
        return;
      }
      const [sessionId, session] = oldest;
      this.#sessions.delete(sessionId);
      this.#logger.warn({ sessionId, sessions: this.#sessions.size }, 'mcp session evicted');
      this.#runSessionClosedHook(sessionId);
      void session.server.close().catch((err: unknown) => {
        this.#logger.warn({ err, sessionId }, 'mcp session close failed');
      });
    }
  }
}
