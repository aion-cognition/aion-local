import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withSubstrate } from './substrate.js';

/**
 * The ordering case, which is the crash itself: every command opens a logger before it does
 * anything, and the path it opens has to be resolved before that.
 *
 * `aion init --install native` on a fresh host died on `ENOENT: mkdir '/data/logs'` inside
 * `withSubstrate`, before a line of output. What fixes it is where the resolution happens rather
 * than what it resolves to, so this asserts the ordering against a real logger open under a
 * scratch home.
 */

let home: string;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aion-cli-roots-'));
  saved = { ...process.env };
  // The three the container defaults would otherwise answer, and the profile that decides nothing
  // here: the resolution is host-context, not profile, so a bare run gets it too.
  delete process.env.AION_DATA_DIR;
  delete process.env.AION_SQLITE_PATH;
  delete process.env.AION_LOG_FILE;
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...saved };
  rmSync(home, { recursive: true, force: true });
});

describe('the lifecycle every command shares', () => {
  it('opens the logger under the resolved data root rather than at /data', async () => {
    let seen = '';

    const code = await withSubstrate({
      spec: { command: 'probe', usage: 'probe' },
      argv: [],
      write: () => undefined,
      parse: () => ({}),
      run: (substrate) => {
        // The open is what crashed. Doing it here is the test.
        substrate.logger().info({ probe: true }, 'opened');
        seen = substrate.config.logging.filePath;
        return Promise.resolve(0);
      },
    });

    expect(code).toBe(0);
    expect(seen).toBe(join(home, '.aion', 'logs', 'aion.jsonl'));
    expect(existsSync(seen)).toBe(true);
    expect(readFileSync(seen, 'utf8')).toContain('opened');
    expect(existsSync('/data/logs')).toBe(false);
  });

  it('leaves a data root the environment pinned exactly where it was pinned', async () => {
    const moved = join(home, 'moved');
    process.env.AION_DATA_DIR = moved;

    await withSubstrate({
      spec: { command: 'probe', usage: 'probe' },
      argv: [],
      write: () => undefined,
      parse: () => ({}),
      run: (substrate) => {
        expect(substrate.config.operational.dataDir).toBe(moved);
        expect(substrate.config.sqlite.path).toBe(join(moved, 'aion.sqlite'));
        return Promise.resolve(0);
      },
    });
  });
});
