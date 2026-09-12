import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULTS } from './defaults.js';
import { hostDataDir, prepareSubstrateRoots } from './host-roots.js';
import { loadConfig } from './load-config.js';

/**
 * The crash class this closes: the path defaults in the knob table are container paths, the first
 * thing every command opens is a log file under them, and `/data` on a host is a directory that
 * does not exist and cannot be created. The first real native install died there.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aion-host-roots-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('on a host', () => {
  it('roots all three paths under the home directory, and none of them at /data', () => {
    const env: NodeJS.ProcessEnv = {};

    const roots = prepareSubstrateRoots(env, { home, inContainer: false });

    expect(roots.dataDir).toBe(hostDataDir(home));
    expect(roots.inContainer).toBe(false);
    for (const path of [roots.dataDir, roots.sqlitePath, roots.logFile]) {
      expect(path.startsWith('/data')).toBe(false);
      expect(path.startsWith(home)).toBe(true);
    }
    expect(env.AION_DATA_DIR).toBe(roots.dataDir);
    expect(env.AION_SQLITE_PATH).toBe(roots.sqlitePath);
    expect(env.AION_LOG_FILE).toBe(roots.logFile);
  });

  it('creates the log directory, which is what the logger cannot do for itself', () => {
    // pino's destination makes one level and fails on a missing parent. That is the ENOENT the
    // first native install hit, and it happens before anything can report it.
    const roots = prepareSubstrateRoots({}, { home, inContainer: false });

    expect(existsSync(join(hostDataDir(home), 'logs'))).toBe(true);
    expect(roots.logFile.startsWith(join(hostDataDir(home), 'logs'))).toBe(true);
  });

  it('keeps a data directory somebody set, and roots the rest inside it', () => {
    const moved = join(home, 'elsewhere');

    const roots = prepareSubstrateRoots({ AION_DATA_DIR: moved }, { home, inContainer: false });

    expect(roots.dataDir).toBe(moved);
    expect(roots.sqlitePath).toBe(join(moved, 'aion.sqlite'));
    expect(roots.pinned).toEqual(['AION_DATA_DIR']);
  });

  it('keeps a log file somebody set on its own, and reports it as pinned', () => {
    const logFile = join(home, 'logs', 'mine.jsonl');

    const roots = prepareSubstrateRoots({ AION_LOG_FILE: logFile }, { home, inContainer: false });

    expect(roots.logFile).toBe(logFile);
    expect(roots.dataDir).toBe(hostDataDir(home));
    expect(roots.pinned).toEqual(['AION_LOG_FILE']);
  });

  it('feeds a config whose paths are the resolved ones', () => {
    // The seam: the table keeps the container defaults, so the committed config surface stays the
    // same on every machine, and the environment carries the host answer into the loader.
    const env: NodeJS.ProcessEnv = {};
    prepareSubstrateRoots(env, { home, inContainer: false });

    const config = loadConfig(env);

    expect(config.operational.dataDir).toBe(hostDataDir(home));
    expect(config.sqlite.path).toBe(join(hostDataDir(home), 'aion.sqlite'));
    expect(config.logging.filePath).toBe(join(hostDataDir(home), 'logs', 'aion.jsonl'));
  });
});

describe('in a container', () => {
  it('changes nothing, because the table already carries the mounted volume', () => {
    const env: NodeJS.ProcessEnv = {};

    const roots = prepareSubstrateRoots(env, { home, inContainer: true });

    expect(roots).toMatchObject({
      dataDir: DEFAULTS.operational.dataDir,
      sqlitePath: DEFAULTS.sqlite.path,
      logFile: DEFAULTS.logging.filePath,
      inContainer: true,
    });
    expect(env).toEqual({});
    expect(loadConfig(env).operational.dataDir).toBe('/data');
  });
});
