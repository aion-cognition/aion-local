/**
 * Streamable-HTTP MCP client sized for one hook fire: initialize, notify, one tool call,
 * delete. A session per fire rather than a shared one, because a hook process lives for a
 * single event and holds no state between them.
 *
 * The transport answers either with plain JSON or with an SSE-framed body, and which one it
 * picks is not the client's choice, so both shapes are read.
 */

export type FetchImpl = typeof globalThis.fetch;

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_MCP_PORT = 8765;
const CLIENT_INFO = { name: 'aion-hook', version: '0.0.0' } as const;

export const MCP_SESSION_HEADER = 'mcp-session-id';

/**
 * Read straight off the environment. The config loader is the one reader of AION_* vars
 * everywhere else, but it carries zod and the whole registry with it, and nothing in this
 * subtree may import either.
 */
export function mcpEndpoint(env: Record<string, string | undefined>): string {
  const raw = (env.AION_MCP_PORT ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  const port = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_PORT;
  return `http://127.0.0.1:${port}/mcp`;
}

export type McpCallResult = {
  readonly text: string | undefined;
  readonly structured: Record<string, unknown> | undefined;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An SSE body carries the message on `data:` lines and a plain body carries it whole. The
 * last framed message that holds a result or an error is the answer; earlier frames on the
 * same stream are progress notifications.
 */
export function parseRpcBody(body: string): Record<string, unknown> | undefined {
  const trimmed = body.trim();
  if (trimmed === '') {
    return undefined;
  }
  const direct = tryParseRecord(trimmed);
  if (direct !== undefined) {
    return direct;
  }
  let last: Record<string, unknown> | undefined;
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const frame = tryParseRecord(line.slice('data:'.length).trim());
    if (frame !== undefined && ('result' in frame || 'error' in frame)) {
      last = frame;
    }
  }
  return last;
}

function errorMessageOf(message: Record<string, unknown>): string | undefined {
  const { error } = message;
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.message === 'string' ? error.message : 'unspecified';
}

function firstTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return undefined;
}

export type McpClientOptions = {
  readonly endpoint: string;
  readonly fetchImpl: FetchImpl;
  readonly signal: AbortSignal;
};

export class McpHookClient {
  readonly #endpoint: string;
  readonly #fetchImpl: FetchImpl;
  readonly #signal: AbortSignal;
  #sessionId: string | undefined;
  #nextId = 1;

  constructor(options: McpClientOptions) {
    this.#endpoint = options.endpoint;
    this.#fetchImpl = options.fetchImpl;
    this.#signal = options.signal;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.#sessionId !== undefined) {
      headers[MCP_SESSION_HEADER] = this.#sessionId;
      headers['mcp-protocol-version'] = PROTOCOL_VERSION;
    }
    return headers;
  }

  async #post(body: Record<string, unknown>): Promise<Response> {
    const response = await this.#fetchImpl(this.#endpoint, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body),
      signal: this.#signal,
    });
    if (!response.ok) {
      throw new Error(`mcp POST ${String(body.method)} responded ${response.status}`);
    }
    return response;
  }

  #takeId(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  async open(): Promise<void> {
    const response = await this.#post({
      jsonrpc: '2.0',
      id: this.#takeId(),
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
    const sessionId = response.headers.get(MCP_SESSION_HEADER);
    if (sessionId === null || sessionId === '') {
      throw new Error('mcp initialize returned no session id');
    }
    const message = parseRpcBody(await response.text());
    if (message !== undefined) {
      const failure = errorMessageOf(message);
      if (failure !== undefined) {
        throw new Error(`mcp initialize failed: ${failure}`);
      }
    }
    this.#sessionId = sessionId;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const response = await this.#post({
      jsonrpc: '2.0',
      id: this.#takeId(),
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const message = parseRpcBody(await response.text());
    if (message === undefined) {
      throw new Error(`mcp ${name} returned no parseable message`);
    }
    const failure = errorMessageOf(message);
    if (failure !== undefined) {
      throw new Error(`mcp ${name} failed: ${failure}`);
    }
    const { result } = message;
    if (!isRecord(result)) {
      throw new Error(`mcp ${name} returned no result`);
    }
    return {
      text: firstTextBlock(result.content),
      structured: isRecord(result.structuredContent) ? result.structuredContent : undefined,
    };
  }

  /** Teardown is best effort: the tool call already landed, and a failed DELETE only leaves an idle session for the service's own sweeper. */
  async close(): Promise<void> {
    if (this.#sessionId === undefined) {
      return;
    }
    try {
      await this.#fetchImpl(this.#endpoint, {
        method: 'DELETE',
        headers: this.#headers(),
        signal: this.#signal,
      });
    } catch {
      return;
    } finally {
      this.#sessionId = undefined;
    }
  }
}
