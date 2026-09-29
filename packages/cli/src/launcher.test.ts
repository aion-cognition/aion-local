import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let directory: string;
let repo: string;
let executables: string;
let dockerCalls: string;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'aion-launcher-')));
  repo = join(directory, 'repo with spaces');
  executables = join(directory, 'executables');
  dockerCalls = join(directory, 'docker-calls');
  mkdirSync(executables);
  mkdirSync(join(repo, 'bin'), { recursive: true });
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, 'packages/cli/dist'), { recursive: true });
  writeFileSync(join(repo, 'compose.yaml'), 'name: test\n');
  for (const name of ['aion', 'aion-native']) {
    copyFileSync(
      fileURLToPath(new URL(`../../../bin/${name}`, import.meta.url)),
      join(repo, 'bin', name),
    );
  }
  writeFileSync(
    join(repo, 'scripts/build-record.mjs'),
    `process.stdout.write('fixture-head\\n' + (process.env.FIXTURE_BUILT_SHA ?? '') + '\\n');\n`,
  );
  writeFileSync(
    join(repo, 'packages/cli/dist/main.js'),
    `
process.stdout.write(JSON.stringify({
  backend: 'native',
  args: process.argv.slice(2),
  cwd: process.cwd(),
  repo: process.env.AION_REPO_PATH,
  provider: process.env.AION_GENERATION_PROVIDER,
  marker: process.env.AION_FIXTURE_MARKER,
  build: process.env.AION_BUILD_SHA,
  head: process.env.AION_REPO_HEAD_SHA,
}));
`,
  );
  writeFileSync(
    join(executables, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DOCKER_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'image') {
  if (args.includes('--format')) {
    process.stdout.write(args.at(-1).includes('Config.Env')
      ? 'AION_BUILD_SHA=' + (process.env.FIXTURE_IMAGE_SHA ?? '') + '\\n'
      : '2999-01-01T00:00:00.000000000Z');
  }
  process.exit(process.env.FIXTURE_IMAGE_MISSING === '1' ? 1 : 0);
}
if (args.includes('run')) {
  process.stdout.write(JSON.stringify({backend: 'docker', args, cwd: process.cwd(), repo: process.env.AION_REPO_PATH}));
}
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function launch(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; executable?: string } = {},
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('AION_')),
  );
  return spawnSync('/bin/bash', [options.executable ?? join(repo, 'bin/aion'), ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...env,
      PATH: `${executables}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: directory,
      LC_ALL: 'C',
      AION_SKIP_IMAGE_CHECK: '1',
      FIXTURE_DOCKER_CALLS: dockerCalls,
      ...options.env,
    },
  });
}

function calls(): string[][] {
  if (!existsSync(dockerCalls)) {
    return [];
  }
  return readFileSync(dockerCalls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
}

describe('the shared aion launcher', () => {
  it('runs a recorded native install from any directory without invoking Docker', () => {
    writeFileSync(
      join(repo, '.env'),
      'AION_INSTALL_PROFILE=native\nAION_GENERATION_PROVIDER=openai\nAION_FIXTURE_MARKER=from-file\n',
    );
    const result = launch(['status'], { env: { FIXTURE_BUILT_SHA: 'built-head' } });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      backend: 'native',
      args: ['status'],
      cwd: repo,
      repo,
      provider: 'openai',
      marker: 'from-file',
      head: 'fixture-head',
      build: 'built-head',
    });
    expect(calls()).toEqual([]);
  });

  it('does not inherit a false build stamp when the source was not built', () => {
    writeFileSync(join(repo, '.env'), 'AION_INSTALL_PROFILE=native\n');
    const result = launch(['doctor'], { env: { AION_BUILD_SHA: 'stale-parent' } });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty('build');
  });

  it('preserves exported settings over the file for ordinary commands', () => {
    writeFileSync(
      join(repo, '.env'),
      'AION_INSTALL_PROFILE=native\nAION_FIXTURE_MARKER=from-file\n',
    );
    const result = launch(['status'], { env: { AION_FIXTURE_MARKER: 'from-shell' } });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('marker', 'from-shell');
  });

  it('reads dotenv values literally, preserves spaces, and uses the last repeated entry', () => {
    const sentinel = join(directory, 'must-not-exist');
    const literal = `two words $(touch '${sentinel}') # literal`;
    writeFileSync(
      join(repo, '.env'),
      [
        ' AION_INSTALL_PROFILE = "native" ',
        'AION_FIXTURE_MARKER=first',
        `AION_FIXTURE_MARKER=${literal}`,
        'REPO_DIR=/must-not-be-used',
      ].join('\n'),
    );
    const result = launch(['status']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('marker', literal);
    expect(existsSync(sentinel)).toBe(false);
    expect(calls()).toEqual([]);
  });

  it('removes matching value quotes without expanding a quoted shell expression', () => {
    const literal = `\${HOME}/literal directory`;
    writeFileSync(
      join(repo, '.env'),
      `AION_INSTALL_PROFILE='native'\nAION_FIXTURE_MARKER='${literal}'\n`,
    );
    const result = launch(['status']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('marker', literal);
  });

  it('dispatches a recorded Docker install through compose with arguments intact', () => {
    writeFileSync(join(repo, '.env'), 'AION_INSTALL_PROFILE=docker\n');
    const result = launch(['search', 'two words']);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { args: string[] };
    expect(output).toEqual({
      backend: 'docker',
      cwd: repo,
      repo,
      args: expect.any(Array),
    });
    expect(output.args.slice(0, 5)).toEqual([
      'compose',
      '-f',
      join(repo, 'compose.yaml'),
      'run',
      '--rm',
    ]);
    expect(output.args.slice(-3)).toEqual(['aion-cli', 'search', 'two words']);
    expect(output.args).toContain('AION_INSTALL_PROFILE');
    expect(output.args).not.toContain('AION_BUILD_SHA');
    expect(output.args).not.toContain('AION_SKIP_IMAGE_CHECK');
    expect(calls()).toHaveLength(2);
  });

  it('builds a missing Docker image before running the command', () => {
    const result = launch(['status'], { env: { FIXTURE_IMAGE_MISSING: '1' } });

    expect(result.status).toBe(0);
    expect(calls().map((args) => args[3])).toEqual([undefined, 'build', 'run']);
  });

  it('rebuilds an image stamped with different source even when no newer file remains', () => {
    const result = launch(['status'], {
      env: { AION_SKIP_IMAGE_CHECK: undefined, FIXTURE_IMAGE_SHA: 'older-head' },
    });

    expect(result.status).toBe(0);
    expect(calls().filter((args) => args.includes('build'))).toHaveLength(1);
  });

  it('selects native setup before a Docker-shaped template has been converted', () => {
    const original = 'AION_INSTALL_PROFILE=docker\nAION_DATA_DIR=/data\n';
    writeFileSync(join(repo, '.env'), original);
    const result = launch(['init', '--provider', 'openai', '--install', 'native', '--yes']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('backend', 'native');
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe(original);
    expect(calls()).toEqual([]);
  });

  it('answers help from the same catalog without touching Docker or a data directory', () => {
    writeFileSync(join(repo, '.env'), 'AION_INSTALL_PROFILE=docker\nAION_DATA_DIR=/data\n');
    for (const args of [[], ['help'], ['init', '--help'], ['doctor', '-h']]) {
      const result = launch(args);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveProperty('backend', 'native');
    }
    expect(calls()).toEqual([]);
    expect(existsSync(join(directory, '.aion'))).toBe(false);
  });

  it('rejects invalid and conflicting modes before starting either runtime', () => {
    for (const args of [
      ['init', '--install', 'bad'],
      ['init', '--install'],
      ['init', '--install', 'native', '--profile', 'docker'],
    ]) {
      const result = launch(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    }
    expect(calls()).toEqual([]);
  });

  it('refuses a mode switch on an existing native configuration before contacting Docker', () => {
    writeFileSync(join(repo, '.env'), 'AION_INSTALL_PROFILE=native\n');
    const result = launch(['init', '--install', 'docker']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not migrate an existing substrate');
    expect(calls()).toEqual([]);
  });

  it('follows PATH symlinks and the old native alias back to the shared launcher', () => {
    writeFileSync(join(repo, '.env'), 'AION_INSTALL_PROFILE=native\n');
    const link = join(executables, 'aion');
    symlinkSync(join(repo, 'bin/aion-native'), link);
    const result = launch(['status'], { executable: link });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('repo', repo);
    expect(calls()).toEqual([]);
  });

  it('keeps both wrapper files valid bash', () => {
    expect(() => execFileSync('/bin/bash', ['-n', join(repo, 'bin/aion')])).not.toThrow();
    expect(() => execFileSync('/bin/bash', ['-n', join(repo, 'bin/aion-native')])).not.toThrow();
  });
});
