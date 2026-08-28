import pino from 'pino';
import type { Logger } from 'pino';

export type { Logger } from 'pino';

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

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Bootstrap resolution for the two logging knobs, used before the config module is
 * available. The config module owns the rest of the AION_* catalog and passes a
 * LogTarget in directly.
 */
export function logTargetFromEnv(env: NodeJS.ProcessEnv = process.env): LogTarget {
  const level = env[LOG_LEVEL_ENV_VAR];
  return {
    filePath: env[LOG_FILE_ENV_VAR] ?? DEFAULT_LOG_FILE,
    level: level !== undefined && isLogLevel(level) ? level : DEFAULT_LOG_LEVEL,
  };
}

/**
 * Opens the JSONL log destination and returns the logger bound to it. Writes are
 * synchronous so a crash never loses the tail that explains it.
 */
export function openLogger(target: LogTarget): Logger {
  const destination = pino.destination({ dest: target.filePath, mkdir: true, sync: true });
  return pino(
    {
      level: target.level,
      ...(target.name === undefined ? {} : { name: target.name }),
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
