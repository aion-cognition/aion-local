import { bootstrapService, type AionService } from './bootstrap.js';

/** Compose sends SIGTERM on `down`/`stop`; SIGINT is the foreground run. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * Closes in dependency order and leaves the event loop empty rather than calling
 * `process.exit`, so the log destination flushes what the shutdown wrote.
 */
function installShutdown(started: AionService): void {
  let stopping = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      if (stopping) {
        return;
      }
      stopping = true;
      started.logger.info({ signal }, 'mcp service stopping');
      void started.close().catch((err: unknown) => {
        started.logger.error({ err }, 'mcp service shutdown failed');
        process.exitCode = 1;
      });
    });
  }
}

/**
 * A startup failure is reported on stderr as well as in the log: compose captures stdio,
 * and the log file lives on a volume the operator may not have opened yet.
 */
export async function runService(env: NodeJS.ProcessEnv): Promise<number> {
  let started: AionService;
  try {
    started = await bootstrapService(env);
  } catch (err) {
    process.stderr.write(`aion-mcp: ${describeError(err)}\n`);
    return 1;
  }

  try {
    await started.service.listen();
  } catch (err) {
    started.logger.fatal({ err }, 'mcp service failed to bind');
    process.stderr.write(`aion-mcp: ${describeError(err)}\n`);
    await started.close();
    return 1;
  }

  installShutdown(started);
  return 0;
}
