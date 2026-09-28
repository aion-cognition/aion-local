#!/usr/bin/env node
// What a finished build holds, for the native profile's build stamp.
//
// The stamp used to compare mtimes: the newest tracked source against the two entry files. An
// incremental `tsc -b` leaves an entry file untouched when its own output did not change, so an
// edit anywhere else read as newer than a build that already held it, and a good build went
// unstamped. The stamp also said nothing about uncommitted source: a build of a dirty tree carried
// the bare HEAD sha, the same as a build of that exact commit.
//
// This records content instead. `npm run build` runs `begin` before the compiler and `finish`
// after it succeeds; `finish` writes the record only when the inputs the compiler read are the
// ones `begin` saw, and it notes the compiler's own incremental state. `state` is what the
// wrapper asks: the stamp of the source on disk now, and whether the recorded build holds it.
//
// No dependencies, because `begin` runs before anything is built.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the compiler reads: every package's source, manifests, lockfile and compiler settings. */
const INPUTS = [
  'packages/*/src/*',
  'packages/*/package.json',
  'packages/*/tsconfig*.json',
  'package.json',
  'package-lock.json',
  'tsconfig*.json',
  ':(exclude)*.test.ts',
  ':(exclude)*.fixture.*',
];

/** The outputs the two entry points need, and the compiler's record of each project it built. */
const OUTPUTS = ['packages/mcp/dist/main.js', 'packages/cli/dist/main.js'];
const COMPILER_STATE = ['protocol', 'core', 'mcp', 'cli'].map(
  (name) => `packages/${name}/dist/.tsbuildinfo`,
);

const RECORD = 'packages/mcp/dist/aion-build.json';
const PENDING = 'packages/mcp/dist/aion-build.pending.json';

function git(root, args, input) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    ...(input === undefined ? {} : { input }),
  });
}

function digest(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * The source as it is on disk: tracked and untracked input files by content, and whether any of
 * it differs from HEAD. Content rather than mtimes, so touching a file changes nothing and an
 * edit reverted by hand reads as the source it was.
 */
export function sourceState(root) {
  const listed = git(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    ...INPUTS,
  ])
    .split('\0')
    .filter((path) => path !== '' && existsSync(join(root, path)));
  const paths = [...new Set(listed)].sort();
  const blobs =
    paths.length === 0
      ? []
      : git(root, ['hash-object', '--stdin-paths'], `${paths.join('\n')}\n`)
          .trim()
          .split('\n');
  const inputs = digest(paths.flatMap((path, index) => [path, blobs[index] ?? '']));
  const head = git(root, ['rev-parse', '--short', 'HEAD']).trim();
  const changed = git(root, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    ...INPUTS,
  ]).trim();
  const dirty = changed !== '';
  return { head, dirty, inputs, stamp: dirty ? `${head}-dirty-${inputs.slice(0, 8)}` : head };
}

function compilerState(root) {
  return Object.fromEntries(
    COMPILER_STATE.map((path) => {
      const file = join(root, path);
      return [path, existsSync(file) ? digest([readFileSync(file, 'utf8')]) : null];
    }),
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Before the compiler runs: no record survives into a build that may fail. */
export function begin(root) {
  rmSync(join(root, RECORD), { force: true });
  mkdirSync(dirname(join(root, PENDING)), { recursive: true });
  writeFileSync(join(root, PENDING), `${JSON.stringify(sourceState(root))}\n`);
}

/**
 * After the compiler succeeded. The record is written only if the source did not move while it
 * ran, since a build that read half of one tree and half of another holds neither.
 */
export function finish(root) {
  const before = readJson(join(root, PENDING));
  rmSync(join(root, PENDING), { force: true });
  const after = sourceState(root);
  if (before?.inputs !== after.inputs) {
    return { recorded: false, reason: 'the source changed while it was building' };
  }
  const missing = OUTPUTS.filter((path) => !existsSync(join(root, path)));
  if (missing.length > 0) {
    return { recorded: false, reason: `the build left no ${missing.join(', ')}` };
  }
  const record = { ...after, compiler: compilerState(root) };
  writeFileSync(join(root, RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return { recorded: true, stamp: after.stamp };
}

/**
 * The stamp of the source on disk now, and the stamp of the build when the recorded build holds
 * exactly that source. It holds it when a record exists, the required outputs exist, the compiler
 * state is the one the record was written after (a `tsc -b` outside the build flow changes it), and
 * the inputs are the ones the record names. The build stamp follows the source, so a commit that
 * touched no input still names the build that holds it.
 */
export function state(root) {
  const source = sourceState(root);
  const record = readJson(join(root, RECORD));
  const holds =
    record !== undefined &&
    OUTPUTS.every((path) => existsSync(join(root, path))) &&
    JSON.stringify(record.compiler) === JSON.stringify(compilerState(root)) &&
    record.inputs === source.inputs;
  return { source: source.stamp, built: holds ? source.stamp : undefined };
}

function main() {
  const [command, rootArg] = process.argv.slice(2);
  const root = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  if (command === 'begin') {
    begin(root);
    return;
  }
  if (command === 'finish') {
    const outcome = finish(root);
    if (!outcome.recorded) {
      process.stderr.write(
        `build record not written: ${outcome.reason}; build again from a stable checkout ` +
          'before stamping a service with it\n',
      );
    }
    return;
  }
  if (command === 'state') {
    const { source, built } = state(root);
    process.stdout.write(`${source}\n${built ?? ''}\n`);
    return;
  }
  process.stderr.write('usage: build-record.mjs begin|finish|state [repo]\n');
  process.exitCode = 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
