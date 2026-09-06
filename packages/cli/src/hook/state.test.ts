import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_STATE, readHookState, stateFilePath, writeHookState } from './state.js';

const SESSION_ID = 'codex-session-3';

describe('hook state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-hook-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries the file fingerprint back to the read that follows the write', () => {
    writeHookState(dir, SESSION_ID, {
      offset: 4096,
      lastFlushAt: '2026-09-06T04:00:00.000Z',
      fingerprint: 'a3f1c0',
      tools: [],
    });

    expect(readHookState(dir, SESSION_ID)).toEqual({
      offset: 4096,
      lastFlushAt: '2026-09-06T04:00:00.000Z',
      fingerprint: 'a3f1c0',
      tools: [],
    });
  });

  it('reads a file written before the fingerprint existed as having none', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      stateFilePath(dir, SESSION_ID),
      `${JSON.stringify({ offset: 512, lastFlushAt: '2026-09-06T04:00:00.000Z', tools: [] })}\n`,
      'utf8',
    );

    const state = readHookState(dir, SESSION_ID);

    expect(state.fingerprint).toBeUndefined();
    expect(state.offset).toBe(512);
  });

  it('starts a session that has never been written with no fingerprint', () => {
    expect(readHookState(dir, 'never-written')).toEqual(EMPTY_STATE);
    expect(EMPTY_STATE.fingerprint).toBeUndefined();
  });
});
