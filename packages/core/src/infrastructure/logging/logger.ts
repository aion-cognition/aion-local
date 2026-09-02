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

export type LogTarget = {
  filePath: string;
  level: LogLevel;
  name?: string;
  /**
   * Tee the JSONL to fd 1 as well. The service sets it, because fd 1 is what `docker logs`
   * reads. A CLI command leaves it off: fd 1 is where it writes its answer, and a record
   * interleaved there breaks the one JSON object `--json` promises its caller.
   */
  stdout?: boolean;
};

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
  const file = pino.destination({ dest: target.filePath, mkdir: true, sync: true });
  dropWriteErrors(file);
  const streams = [{ stream: file, level: target.level }];
  if (target.stdout === true) {
    const stdout = pino.destination({ dest: 1, sync: true });
    dropWriteErrors(stdout);
    streams.unshift({ stream: stdout, level: target.level });
  }
  return pino(
    {
      level: target.level,
      ...(target.name === undefined ? {} : { name: target.name }),
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
}
