import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  bindHost,
  headerValue,
  JSONRPC_INVALID_REQUEST,
  MAX_BODY_BYTES,
  readJsonBody,
  RequestBodyError,
  writeJsonRpcError,
} from './http.js';

function request(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage;
}

type CapturedResponse = {
  readonly res: ServerResponse;
  status(): number;
  body(): string;
};

function capture(): CapturedResponse {
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

describe('body reading', () => {
  it('parses the JSON-RPC envelope the transport will replay', async () => {
    const body = await readJsonBody(request('{"jsonrpc":"2.0","method":"initialize","id":1}'));
    expect(body).toEqual({ jsonrpc: '2.0', method: 'initialize', id: 1 });
  });

  it('names malformed JSON rather than throwing a SyntaxError at the router', async () => {
    await expect(readJsonBody(request('{not json'))).rejects.toBeInstanceOf(RequestBodyError);
  });

  it('rejects an empty body, which no MCP POST ever has', async () => {
    await expect(readJsonBody(request('   '))).rejects.toBeInstanceOf(RequestBodyError);
  });

  it('stops reading past the cap instead of buffering an unbounded payload', async () => {
    const oversized = Readable.from([
      Buffer.alloc(MAX_BODY_BYTES, 0x61),
      Buffer.from('extra', 'utf8'),
    ]) as unknown as IncomingMessage;

    await expect(readJsonBody(oversized)).rejects.toThrow(/exceeds/);
  });
});

describe('headers', () => {
  it('takes the first value when a header repeats', () => {
    const req = {
      headers: { 'mcp-session-id': ['first', 'second'] },
    } as unknown as IncomingMessage;
    expect(headerValue(req, 'mcp-session-id')).toBe('first');
  });

  it('is undefined when the header is absent', () => {
    const req = { headers: {} } as unknown as IncomingMessage;
    expect(headerValue(req, 'mcp-session-id')).toBeUndefined();
  });
});

describe('error responses', () => {
  it('answers in the JSON-RPC shape the client is already parsing', () => {
    const captured = capture();
    writeJsonRpcError(captured.res, 404, JSONRPC_INVALID_REQUEST, 'unknown session: abc');

    expect(captured.status()).toBe(404);
    expect(JSON.parse(captured.body())).toEqual({
      jsonrpc: '2.0',
      error: { code: JSONRPC_INVALID_REQUEST, message: 'unknown session: abc' },
      id: null,
    });
  });
});

describe('bind host', () => {
  it('binds loopback on bare metal, where nothing else confines the port', () => {
    expect(bindHost(false)).toBe('127.0.0.1');
  });

  it('binds every interface in the container, since Docker forwards to the container address', () => {
    expect(bindHost(true)).toBe('0.0.0.0');
  });
});
