import { renameSync, rmSync, statSync } from 'node:fs';
import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger } from 'pino';

/** Names for the config registry, which is the only place either variable is read. */
export const LOG_FILE_ENV_VAR = 'AION_LOG_FILE';
export const LOG_LEVEL_ENV_VAR = 'AION_LOG_LEVEL';

/** In-container path on the aion-data volume. Host-run tests override it. */
export const DEFAULT_LOG_FILE = '/data/logs/aion.jsonl';
export const DEFAULT_LOG_LEVEL = 'info';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_RETENTION_ENV_VAR = 'AION_LOG_RETENTION_DAYS';

/** A day. The file is a tail somebody reads after something went wrong, not an archive. */
export const DEFAULT_LOG_RETENTION_DAYS = 1;

/** The rolled copy, which is the only history kept: current plus previous, both aged out. */
export const ROLLED_LOG_SUFFIX = '.1';

export type LogTarget = {
  filePath: string;
  level: LogLevel;
  name?: string;
  /** Days of file log kept, fractions allowed. Absent leaves the current file alone. */
  retentionDays?: number;
  /** Injected by tests; the wall clock answers it in a real run. */
  now?: () => Date;
  /**
   * Tee the JSONL to fd 1 as well. The service sets it, because fd 1 is what `docker logs`
   * reads. A CLI command leaves it off: fd 1 is where it writes its answer, and a record
   * interleaved there breaks the one JSON object `--json` promises its caller.
   */
  stdout?: boolean;
};

export type LogRetentionOutcome = {
  /** The current file was older than the window and became the rolled copy. */
  readonly rolled: boolean;
  /** A rolled copy older than the window went. */
  readonly pruned: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function olderThan(path: string, cutoff: Date): boolean {
  try {
    return statSync(path).mtime.getTime() < cutoff.getTime();
  } catch {
    // Not there, or not readable. Either way there is nothing to age out.
    return false;
  }
}

/**
 * Ages the file log out, in the smallest mechanism that needs no dependency: one roll and one
 * delete, against the file's own modification time.
 *
 * A file whose last write is older than the window becomes `aion.jsonl.1`, replacing whatever
 * rolled copy was there, and the process opens a fresh one. A rolled copy with nothing to replace
 * it and an age past the window is deleted instead. So the disk holds at most the current window
 * and the one before it, and a substrate nobody has written to in a week keeps its last window.
 *
 * Modification time rather than a record inside the file: the last write is what "how old is this
 * log" means, it costs one `stat`, and it stays true for a file this build never wrote to.
 *
 * This is the file logger only. The graph's transaction logs are Neo4j's own setting
 * (`db.tx_log.rotation.retention_policy`), and the container's stdout copy keeps the compose
 * json-file cap as a belt.
 */
export function enforceLogRetention(
  filePath: string,
  retentionDays: number,
  now: Date = new Date(),
): LogRetentionOutcome {
  const rolledPath = `${filePath}${ROLLED_LOG_SUFFIX}`;
  const cutoff = new Date(now.getTime() - Math.max(retentionDays, 0) * DAY_MS);
  const rolling = olderThan(filePath, cutoff);
  const stale = olderThan(rolledPath, cutoff);
  if (rolling) {
    try {
      // Over whatever rolled copy is there: the roll is what replaces the previous window, and a
      // rolled file's own age is always past the window by construction, so ageing it out
      // separately here would leave no history at all.
      renameSync(filePath, rolledPath);
    } catch {
      // A file that cannot be renamed is one this process cannot fix, and the run has to
      // continue: losing rotation is cheaper than refusing to start over a log file.
      return { rolled: false, pruned: false };
    }
    return { rolled: true, pruned: false };
  }
  if (stale) {
    // Nothing to replace it with, and it is past the window: a substrate nobody has written to in
    // a week keeps its last window and not the one before that.
    rmSync(rolledPath, { force: true });
  }
  return { rolled: false, pruned: stale };
}

function dropWriteErrors(destination: pino.DestinationStream & NodeJS.EventEmitter): void {
  destination.on('error', () => {
    // Nothing to do and nowhere to say it: the sink that would carry the complaint is the one
    // that failed.
  });
}

/**
 * Opens the JSONL log destinations and returns the logger. The file on the data volume is the
 * durable copy a human tails, and `stdout` adds the fd 1 tee for the service. Writes are
 * synchronous so a crash never loses the tail that explains it. Each stream states the level
 * explicitly: a multistream entry with no level defaults to info and would drop debug/trace
 * even when the logger is configured to pass them.
 *
 * A failed write drops the record rather than throwing: the destinations are event emitters,
 * and an unhandled `error` on one takes the process down over a log line. Losing a line is
 * always cheaper, and the case is real when a CLI run is piped to a reader that exits first.
 */
export function openLogger(target: LogTarget): Logger {
  // Before the destination opens, so a fresh process writes into a fresh file rather than
  // appending to one it is about to roll. Every entry point opens a logger, which is what gives
  // both profiles the same enforcement without a second place to wire it: the first start after
  // an upgrade ages out whatever the old build left, and says so on the line below.
  const aged =
    target.retentionDays === undefined
      ? { rolled: false, pruned: false }
      : enforceLogRetention(target.filePath, target.retentionDays, target.now?.() ?? new Date());
  const file = pino.destination({ dest: target.filePath, mkdir: true, sync: true });
  dropWriteErrors(file);
  const streams = [{ stream: file, level: target.level }];
  if (target.stdout === true) {
    const stdout = pino.destination({ dest: 1, sync: true });
    dropWriteErrors(stdout);
    streams.unshift({ stream: stdout, level: target.level });
  }
  const logger = pino(
    {
      level: target.level,
      ...(target.name === undefined ? {} : { name: target.name }),
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
  if (aged.rolled || aged.pruned) {
    logger.info(
      { rolled: aged.rolled, pruned: aged.pruned, retentionDays: target.retentionDays },
      'file log aged out',
    );
  }
  return logger;
}
