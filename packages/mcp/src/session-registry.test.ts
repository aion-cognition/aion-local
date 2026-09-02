import { openLogger, type Logger } from '@aion/core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpSessionRegistry, type McpSession } from './session-registry.js';

/**
 * The map's own bookkeeping: which sessions exist, which one a request belongs to, and which
 * ones get evicted or swept. What each of those does to the transport and the server is out
 * of scope, so every session here is a fake the registry never has to look inside.
 */

const MAX_SESSIONS = 512;

let dir: string;
let logger: Logger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-session-registry-'));
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeSession(): McpSession {
  return {
    transport: {} as StreamableHTTPServerTransport,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- test double for the SDK's Server, not a use of the deprecated API surface.
    server: { close: () => Promise.resolve() } as unknown as Server,
    lastActivityAt: Date.now(),
  };
}

describe('McpSessionRegistry eviction', () => {
  it('runs the session-closed hook on the session it evicts', () => {
    const closed: string[] = [];
    const registry = new McpSessionRegistry(logger, (sessionId) => closed.push(sessionId));

    for (let index = 0; index <= MAX_SESSIONS; index += 1) {
      registry.open(`session-${String(index)}`, fakeSession());
    }

    expect(registry.size).toBe(MAX_SESSIONS);
    expect(closed).toEqual(['session-0']);
  });

  it('lets a later real close of the evicted session no-op rather than double-fire the hook', () => {
    const closed: string[] = [];
    const registry = new McpSessionRegistry(logger, (sessionId) => closed.push(sessionId));

    for (let index = 0; index <= MAX_SESSIONS; index += 1) {
      registry.open(`session-${String(index)}`, fakeSession());
    }
    // What `server.onclose` calls once the evicted session's own close settles.
    registry.forget('session-0');

    expect(closed).toEqual(['session-0']);
  });
});
