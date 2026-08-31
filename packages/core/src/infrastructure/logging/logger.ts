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
};

/**
 * Opens the JSONL log destinations and returns the logger teed to both. stdout (fd 1) is what
 * `docker logs` reads; the file on the data volume is the durable copy a human tails. Writes
 * are synchronous so a crash never loses the tail that explains it. Each stream states the
 * level explicitly: a multistream entry with no level defaults to info and would drop
 * debug/trace even when the logger is configured to pass them.
 */
export function openLogger(target: LogTarget): Logger {
  const stdout = pino.destination({ dest: 1, sync: true });
  const file = pino.destination({ dest: target.filePath, mkdir: true, sync: true });
  return pino(
    {
      level: target.level,
      ...(target.name === undefined ? {} : { name: target.name }),
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { stream: stdout, level: target.level },
      { stream: file, level: target.level },
    ]),
  );
}
