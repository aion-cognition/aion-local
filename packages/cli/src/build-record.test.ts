import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The native build stamp, over a real git repository. The compiler itself is stood in for by
 * writing what it writes (the entry files and each project's `.tsbuildinfo`), because what the
 * record decides is whether a finished build holds the source on disk, not how the build ran.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'build-record.mjs',
);

/** Each case spawns git and node several times, which a loaded parallel run makes slow. */
const SPAWNS = 30_000;

let repo: string;
let tools: string;

/**
 * A compiler that answers the dry run the way `tsc -b --dry` does: nothing when every project is
 * current, a "would build" line when one is not. Which one it says is the file's contents.
 */
function compilerSays(output: string): void {
  writeFileSync(join(tools, 'said.txt'), output);
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function record(command: 'begin' | 'finish'): string {
  return execFileSync('node', [SCRIPT, command, repo], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function state(): { source: string; built: string } {
  const [source = '', built = ''] = execFileSync('node', [SCRIPT, 'state', repo], {
    encoding: 'utf8',
  }).split('\n');
  return { source, built };
}

/** What `tsc -b` leaves behind, with a revision so a second build writes different state. */
function compile(revision = 1): void {
  for (const name of ['protocol', 'core', 'mcp', 'cli']) {
    write(`packages/${name}/dist/.tsbuildinfo`, `{"revision":${String(revision)}}`);
  }
  write('packages/mcp/dist/main.js', 'export {};\n');
  write('packages/cli/dist/main.js', 'export {};\n');
}

/** `npm run build`: begin, the compiler, and finish only when the compiler succeeded. */
function build(revision = 1): void {
  record('begin');
  compile(revision);
  record('finish');
}

function commit(message: string): void {
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

beforeEach(() => {
  tools = mkdtempSync(join(tmpdir(), 'aion-build-record-tsc-'));
  writeFileSync(
    join(tools, 'tsc.mjs'),
    "import { readFileSync } from 'node:fs';\n" +
      "process.stdout.write(readFileSync(new URL('./said.txt', import.meta.url), 'utf8'));\n",
  );
  compilerSays('');
  process.env.BUILD_RECORD_TSC = join(tools, 'tsc.mjs');
  repo = mkdtempSync(join(tmpdir(), 'aion-build-record-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  write('.gitignore', 'dist/\n');
  write('package.json', '{"name":"fixture"}\n');
  write('package-lock.json', '{"lockfileVersion":3}\n');
  write('tsconfig.json', '{}\n');
  write('packages/core/src/index.ts', 'export const answer = 42;\n');
  write('packages/core/src/index.test.ts', 'export {};\n');
  write('packages/mcp/src/main.ts', 'export {};\n');
  write('packages/cli/src/main.ts', 'export {};\n');
  commit('fixture');
});

afterEach(() => {
  delete process.env.BUILD_RECORD_TSC;
  rmSync(repo, { recursive: true, force: true });
  rmSync(tools, { recursive: true, force: true });
});

describe('the build stamp', () => {
  it(
    'names the exact commit a clean build holds',
    () => {
      build();

      const head = git('rev-parse', '--short', 'HEAD');
      expect(state()).toEqual({ source: head, built: head });
    },
    SPAWNS,
  );

  it(
    'recognises an incremental build that left the entry files untouched',
    () => {
      build();
      const old = new Date('2020-01-01T00:00:00Z');
      utimesSync(join(repo, 'packages/mcp/dist/main.js'), old, old);
      utimesSync(join(repo, 'packages/cli/dist/main.js'), old, old);
      write('packages/core/src/index.ts', 'export const answer = 42; // a comment\n');

      record('begin');
      compile(2);
      record('finish');

      expect(state().built).toBe(state().source);
      expect(state().built).not.toBe('');
    },
    SPAWNS,
  );

  it(
    'never reports an unbuilt change as the build, and says the source is dirty',
    () => {
      build();
      write('packages/core/src/index.ts', 'export const answer = 43;\n');

      const now = state();
      expect(now.built).toBe('');
      expect(now.source).toMatch(/^[0-9a-f]+-dirty-[0-9a-f]{8}$/);
    },
    SPAWNS,
  );

  it(
    'stamps a build of a dirty tree as dirty, and as the commit once that source is committed',
    () => {
      write('packages/core/src/index.ts', 'export const answer = 43;\n');
      build();
      const dirty = state();
      expect(dirty.built).toMatch(/-dirty-/);

      commit('the same change, committed');

      const head = git('rev-parse', '--short', 'HEAD');
      expect(state()).toEqual({ source: head, built: head });
    },
    SPAWNS,
  );

  it(
    'counts an untracked source file and a dependency change as unbuilt',
    () => {
      build();
      write('packages/core/src/new.ts', 'export {};\n');
      expect(state().built).toBe('');

      unlinkSync(join(repo, 'packages/core/src/new.ts'));
      expect(state().built).not.toBe('');

      write('package-lock.json', '{"lockfileVersion":3,"changed":true}\n');
      expect(state().built).toBe('');
    },
    SPAWNS,
  );

  it(
    'leaves no stamp after a build that failed',
    () => {
      build();
      record('begin');
      // The compiler failed, so `postbuild` never ran.

      expect(state().built).toBe('');
    },
    SPAWNS,
  );

  it(
    'writes no record when the source moved while it was building',
    () => {
      record('begin');
      compile();
      write('packages/core/src/index.ts', 'export const answer = 44;\n');
      const finished = spawnSync('node', [SCRIPT, 'finish', repo], { encoding: 'utf8' });

      expect(finished.stderr).toContain('the source changed while it was building');
      expect(state().built).toBe('');
    },
    SPAWNS,
  );

  it(
    'stops holding once an entry file is gone or the output was rebuilt outside the flow',
    () => {
      build();
      unlinkSync(join(repo, 'packages/mcp/dist/main.js'));
      expect(state().built).toBe('');

      build();
      compile(3);
      expect(state().built).toBe('');
    },
    SPAWNS,
  );

  it(
    'is unmoved by touching a file or editing a test the build does not read',
    () => {
      build();
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(repo, 'packages/core/src/index.ts'), later, later);
      write('packages/core/src/index.test.ts', 'export const edited = true;\n');

      expect(state().built).not.toBe('');
    },
    SPAWNS,
  );

  it(
    'writes no record for a build that exited clean without building every project',
    () => {
      record('begin');
      compile();
      compilerSays("A non-dry build would build project '/repo/packages/cli/tsconfig.json'\n");
      const finished = spawnSync('node', [SCRIPT, 'finish', repo], { encoding: 'utf8' });

      expect(finished.stderr).toContain('the compiler still has projects to build');
      expect(state().built).toBe('');
    },
    SPAWNS,
  );

  it(
    'lets a checkout with no git build without a record rather than failing the build',
    () => {
      rmSync(join(repo, '.git'), { recursive: true, force: true });

      const began = spawnSync('node', [SCRIPT, 'begin', repo], { encoding: 'utf8' });
      compile();
      const finished = spawnSync('node', [SCRIPT, 'finish', repo], { encoding: 'utf8' });

      expect(began.status).toBe(0);
      expect(finished.status).toBe(0);
      expect(began.stderr).toContain('build record skipped');
      expect(existsSync(join(repo, 'packages/mcp/dist/aion-build.json'))).toBe(false);
    },
    SPAWNS,
  );
});
