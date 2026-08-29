import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Reflection payloads carry whole transcripts; the cap only exists so a runaway body cannot exhaust the heap. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/health';

/** JSON-RPC 2.0 reserved codes, used for the transport-level rejections that never reach a session. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;

export class RequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new RequestBodyError(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw new RequestBodyError('request body is empty');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new RequestBodyError(err instanceof Error ? err.message : String(err));
  }
}

export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** A rejection that never reached a session still answers in the shape the client is parsing. */
export function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  writeJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Docker publishes the port to the host's loopback (`127.0.0.1:8765:8765`), which forwards
 * to the container's own address: a server bound to loopback *inside* the container would
 * be unreachable through it. Loopback stays the bind for a bare-metal run, where nothing
 * else confines the port.
 */
export function bindHost(inContainer: boolean): string {
  return inContainer ? '0.0.0.0' : '127.0.0.1';
}

export function runningInContainer(): boolean {
  return existsSync('/.dockerenv');
}
