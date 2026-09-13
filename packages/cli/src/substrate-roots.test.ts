import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initConvertsContainerPaths, parseInitFlags } from './init.js';
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
  // Restored in place rather than replaced: `os.homedir()` reads the process environment, and a
  // fresh object assigned over `process.env` stops following it, so a later `HOME` stub would
  // resolve against the machine's own home and the substrate that lives there.
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
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

  /**
   * The docker-shaped `.env` on a host, which `bin/aion-native` sources into every run. The three
   * paths are what `.env.example` ships, so a machine that copied the template and never ran a
   * native init carries them, and `/data` is a directory a host cannot make.
   */
  function dockerShapedEnv(): void {
    process.env.AION_DATA_DIR = '/data';
    process.env.AION_SQLITE_PATH = '/data/aion.sqlite';
    process.env.AION_LOG_FILE = '/data/logs/aion.jsonl';
  }

  it('refuses a docker-shaped .env by name instead of dying on mkdir /data', async () => {
    dockerShapedEnv();
    const said: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    let ran = false;

    const code = await withSubstrate({
      spec: { command: 'probe', usage: 'probe' },
      argv: [],
      write: () => undefined,
      parse: () => ({}),
      run: () => {
        ran = true;
        return Promise.resolve(0);
      },
    });

    expect(code).toBe(1);
    expect(ran).toBe(false);
    const text = said.join('');
    expect(text).toContain('AION_DATA_DIR=/data');
    expect(text).toContain('AION_SQLITE_PATH=/data/aion.sqlite');
    expect(text).toContain('AION_LOG_FILE=/data/logs/aion.jsonl');
    expect(text).toContain('init --install native');
    expect(existsSync('/data/logs')).toBe(false);
  });

  it('converts the same file for the init that is about to rewrite it', async () => {
    dockerShapedEnv();
    let seen = '';

    const code = await withSubstrate({
      spec: { command: 'init', usage: 'aion init' },
      argv: ['--install', 'native'],
      write: () => undefined,
      parse: parseInitFlags,
      convertsContainerPaths: initConvertsContainerPaths,
      run: (substrate) => {
        // The open is what crashed on this file, so the conversion is asserted through it.
        substrate.logger().info({ probe: true }, 'opened');
        seen = substrate.config.operational.dataDir;
        return Promise.resolve(0);
      },
    });

    expect(code).toBe(0);
    expect(seen).toBe(join(home, '.aion'));
    expect(existsSync(join(home, '.aion', 'logs'))).toBe(true);
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
