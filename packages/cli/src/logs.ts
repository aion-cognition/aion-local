import { LOG_LEVELS, type LogLevel } from '@aion/core';
import { existsSync, openSync, readSync, statSync, closeSync } from 'node:fs';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion logs`: the file the logger writes, which is the same file on both profiles.
 *
 * The service tees its records to stdout as well, and on the docker profile `docker logs` reads
 * that copy — but the tee is capped there and absent on the native profile, where it goes to
 * /dev/null. The file is the durable copy under the data root either way, so that is what this
 * reads, and it prints which file it read: a command that shows you a log without saying where it
 * came from is one you cannot check.
 */

const SPEC: ArgSpec = {
  command: 'logs',
  usage: 'aion logs [-n <lines>] [--level <trace|debug|info|warn|error|fatal>] [-f]',
  options: [
    { flag: '--lines', alias: '-n', takesValue: true },
    { flag: '--level', takesValue: true },
    { flag: '--follow', alias: '-f' },
  ],
};

const DEFAULT_LINES = 50;

/** Bounded read: a day of records can be large, and the tail is what anybody asked for. */
const TAIL_BYTES = 1024 * 1024;

const FOLLOW_INTERVAL_MS = 400;

/** pino writes the numeric level; the names are the operator's. */
const LEVEL_VALUES: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export type LogsFlags = {
  readonly lines: number;
  readonly level: LogLevel | undefined;
  readonly follow: boolean;
};

export function parseLogsFlags(argv: readonly string[]): LogsFlags {
  const { flags, values } = parseArgs(SPEC, argv);
  const raw = values.get('--lines');
  const lines = raw === undefined ? DEFAULT_LINES : Number(raw);
  if (!Number.isSafeInteger(lines) || lines <= 0) {
    throw new CliUsageError(`-n takes a positive whole number of lines, not '${raw ?? ''}'`);
  }
  const level = values.get('--level');
  if (level !== undefined && !LOG_LEVELS.includes(level as LogLevel)) {
    throw new CliUsageError(`--level takes one of ${LOG_LEVELS.join(', ')}, not '${level}'`);
  }
  return {
    lines,
    level: level as LogLevel | undefined,
    follow: flags.has('--follow'),
  };
}

/**
 * Whether a record passes the floor. A line that is not a record passes: the file is JSONL and a
 * line that is not is either a crash somebody wrote there or a truncated write, and both are
 * exactly what a person reading logs wants to see.
 */
export function passesLevel(line: string, floor: LogLevel | undefined): boolean {
  if (floor === undefined) {
    return true;
  }
  try {
    const record = JSON.parse(line) as { level?: unknown };
    const floorValue = LEVEL_VALUES[floor];
    return typeof record.level === 'number' ? record.level >= floorValue : true;
  } catch {
    return true;
  }
}

/** The last bytes of the file, decoded and split. A partial first line is dropped, not printed. */
export function readTail(filePath: string, fromByte = 0): { text: string; size: number } {
  const { size } = statSync(filePath);
  const start = fromByte > 0 ? Math.min(fromByte, size) : Math.max(0, size - TAIL_BYTES);
  if (size <= start) {
    return { text: '', size };
  }
  const handle = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(handle, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // Only when the window started mid-file: a first line cut in half is not a record.
    return { text: fromByte === 0 && start > 0 ? text.slice(text.indexOf('\n') + 1) : text, size };
  } finally {
    closeSync(handle);
  }
}

function printable(text: string, floor: LogLevel | undefined): readonly string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => passesLevel(line, floor));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Follows the file, and survives it being rotated under us. The logger ages the file out by
 * renaming it and opening a fresh one, so the size going backwards is the signal that the path
 * now holds a different file; reading from the old offset would skip the new file's first
 * records, which is the half of a rotation a follower actually notices.
 */
export async function followLog(
  filePath: string,
  from: number,
  floor: LogLevel | undefined,
  write: Writer,
  stop: () => boolean,
): Promise<void> {
  let offset = from;
  while (!stop()) {
    await sleep(FOLLOW_INTERVAL_MS);
    if (!existsSync(filePath)) {
      continue;
    }
    const { size } = statSync(filePath);
    if (size < offset) {
      write('--- log rotated, following the new file ---');
      offset = 0;
    }
    if (size === offset) {
      continue;
    }
    const tail = readTail(filePath, offset);
    offset = tail.size;
    for (const line of printable(tail.text, floor)) {
      write(line);
    }
  }
}

export function runLogs(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseLogsFlags,
    run: async (substrate, flags) => {
      const { filePath } = substrate.config.logging;
      write(`reading ${filePath}`);
      if (!existsSync(filePath)) {
        write('no log file yet: nothing has run under this data root.');
        return 0;
      }
      const tail = readTail(filePath);
      const lines = printable(tail.text, flags.level);
      for (const line of lines.slice(-flags.lines)) {
        write(line);
      }
      if (!flags.follow) {
        return 0;
      }
      let stopped = false;
      const onSignal = (): void => {
        stopped = true;
      };
      process.once('SIGINT', onSignal);
      try {
        await followLog(filePath, tail.size, flags.level, write, () => stopped);
      } finally {
        process.off('SIGINT', onSignal);
      }
      return 0;
    },
  });
}
