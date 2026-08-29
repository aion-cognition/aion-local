import {
  ConfigError,
  countQueueJobs,
  countQueueJobsByLane,
  dropUnclaimedJobs,
  GraphConnection,
  isReflectionLane,
  listQueueJobs,
  loadConfig,
  openLogger,
  promoteJobs,
  reconcileEnrichment,
  REFLECTION_LANES,
  SqliteStore,
  type Config,
  type Logger,
  type ReflectionJob,
  type ReflectionLane,
  type ReflectionQueueFilter,
  type SqliteHandle,
} from '@aion/core';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

/**
 * The operator surface the live incident did not have. Triaging a 4,000-job flood took raw
 * SQL inside the container, and reading which episodes would never be enriched took a join
 * nothing exposed; `ls`, `drop`, `promote` and `reconcile` are those four operations.
 *
 * `drop` and `reconcile --re-enqueue` are the only ones that change anything, and both
 * report what they would do and stop unless `--yes` is passed: a queue is triaged under
 * pressure, and a command that acts on the first typed guess is how the wrong session's
 * memory gets thrown away.
 */

const SUBCOMMANDS = ['ls', 'drop', 'promote', 'reconcile'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const DEFAULT_LIST_LIMIT = 50;

export class UnknownSubcommandError extends Error {
  constructor(name: string) {
    super(`unknown queue subcommand '${name}' (supported: ${SUBCOMMANDS.join(', ')})`);
    this.name = 'UnknownSubcommandError';
  }
}

export class UnknownQueueOptionError extends Error {
  constructor(option: string) {
    super(`unknown option '${option}' for queue (supported: --session, --lane, --limit, --re-enqueue, --yes)`);
    this.name = 'UnknownQueueOptionError';
  }
}

export class MissingQueueValueError extends Error {
  constructor(option: string) {
    super(`${option} needs a value`);
    this.name = 'MissingQueueValueError';
  }
}

export class InvalidQueueValueError extends Error {
  constructor(option: string, value: string, expected: string) {
    super(`${option} got '${value}', expected ${expected}`);
    this.name = 'InvalidQueueValueError';
  }
}

export type QueueFlags = {
  readonly subcommand: Subcommand;
  readonly session?: string;
  readonly lane?: ReflectionLane;
  readonly limit?: number;
  readonly reEnqueue: boolean;
  readonly yes: boolean;
};

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new MissingQueueValueError(option);
  }
  return value;
}

export function parseQueueFlags(argv: readonly string[]): QueueFlags {
  const [first = 'ls', ...rest] = argv;
  if (!isSubcommand(first)) {
    throw new UnknownSubcommandError(first);
  }

  let session: string | undefined;
  let lane: ReflectionLane | undefined;
  let limit: number | undefined;
  let reEnqueue = false;
  let yes = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--re-enqueue') {
      reEnqueue = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--session') {
      session = requireValue(rest, index + 1, '--session');
      index += 1;
      continue;
    }
    if (arg === '--lane') {
      const value = requireValue(rest, index + 1, '--lane');
      if (!isReflectionLane(value)) {
        throw new InvalidQueueValueError('--lane', value, REFLECTION_LANES.join(' or '));
      }
      lane = value;
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      const value = requireValue(rest, index + 1, '--limit');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new InvalidQueueValueError('--limit', value, 'a positive integer');
      }
      limit = parsed;
      index += 1;
      continue;
    }
    throw new UnknownQueueOptionError(arg ?? '');
  }

  return {
    subcommand: first,
    reEnqueue,
    yes,
    ...(session === undefined ? {} : { session }),
    ...(lane === undefined ? {} : { lane }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function filterOf(flags: QueueFlags): ReflectionQueueFilter {
  return {
    ...(flags.session === undefined ? {} : { sessionId: flags.session }),
    ...(flags.lane === undefined ? {} : { lane: flags.lane }),
  };
}

function describeFilter(flags: QueueFlags): string {
  const parts: string[] = [];
  if (flags.lane !== undefined) {
    parts.push(`lane=${flags.lane}`);
  }
  if (flags.session !== undefined) {
    parts.push(`session=${flags.session}`);
  }
  return parts.length === 0 ? 'the whole queue' : parts.join(' ');
}

function ageOf(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 120) {
    return `${String(seconds)}s`;
  }
  if (seconds < 7200) {
    return `${String(Math.round(seconds / 60))}m`;
  }
  return `${String(Math.round(seconds / 3600))}h`;
}

/** Column widths are the widest value each field can hold: a uuid session id is 36 characters. */
export function renderQueueJobs(jobs: readonly ReflectionJob[], now: Date, write: Writer): void {
  if (jobs.length === 0) {
    write('no matching jobs');
    return;
  }
  write('lane         age    attempts  session                               job');
  for (const job of jobs) {
    const state = job.claimedAt === null ? '' : ' (claimed)';
    write(
      [
        job.lane.padEnd(12),
        ageOf(job.enqueuedAt, now).padStart(5),
        String(job.attempts).padStart(9),
        `  ${(job.sessionId ?? '-').padEnd(36)}`,
        `${job.id}${state}`,
      ].join(' '),
    );
    if (job.lastError !== null) {
      write(`  last error: ${job.lastError}`);
    }
  }
}

type QueueDeps = {
  readonly db: SqliteHandle;
  readonly config: Config;
  readonly logger: Logger;
  readonly write: Writer;
};

function renderCounts(deps: QueueDeps, flags: QueueFlags): void {
  const counts = countQueueJobs(deps.db, filterOf(flags), deps.config.operational.workerMaxAttempts);
  const byLane = countQueueJobsByLane(deps.db);
  const lanes = REFLECTION_LANES.map((lane) => `${lane}=${String(byLane.get(lane) ?? 0)}`).join(' ');
  deps.write('');
  deps.write(
    `matched  ${String(counts.total)} jobs: ${String(counts.unclaimed)} unclaimed, ${String(counts.claimed)} claimed, ${String(counts.exhausted)} exhausted`,
  );
  deps.write(`pending  ${lanes}`);
}

function runLs(deps: QueueDeps, flags: QueueFlags): number {
  const jobs = listQueueJobs(deps.db, filterOf(flags), flags.limit ?? DEFAULT_LIST_LIMIT);
  renderQueueJobs(jobs, new Date(), deps.write);
  renderCounts(deps, flags);
  return 0;
}

function runDrop(deps: QueueDeps, flags: QueueFlags): number {
  const counts = countQueueJobs(deps.db, filterOf(flags));
  if (counts.unclaimed === 0) {
    deps.write(`nothing to drop: no unclaimed jobs match ${describeFilter(flags)}`);
    return 0;
  }
  if (!flags.yes) {
    deps.write(`would drop ${String(counts.unclaimed)} unclaimed jobs matching ${describeFilter(flags)}`);
    if (counts.claimed > 0) {
      deps.write(`${String(counts.claimed)} claimed jobs are running and are left alone`);
    }
    deps.write('their episodes stay in the graph; re-run with --yes to drop the queue rows');
    return 0;
  }
  const dropped = dropUnclaimedJobs(deps.db, filterOf(flags));
  deps.logger.warn({ dropped, filter: filterOf(flags) }, 'reflection queue jobs dropped');
  deps.write(`dropped ${String(dropped)} unclaimed jobs matching ${describeFilter(flags)}`);
  deps.write('their episodes are still stored; `aion queue reconcile` counts and can re-enqueue them');
  return 0;
}

function runPromote(deps: QueueDeps, flags: QueueFlags): number {
  const promoted = promoteJobs(deps.db, filterOf(flags));
  deps.logger.info({ promoted, filter: filterOf(flags) }, 'reflection queue jobs promoted');
  deps.write(
    `promoted ${String(promoted)} unclaimed jobs to the interactive lane (${describeFilter(flags)})`,
  );
  return 0;
}

async function runReconcile(deps: QueueDeps, flags: QueueFlags): Promise<number> {
  const { write } = deps;
  const connection = new GraphConnection(deps.config.neo4j);
  try {
    const health = await connection.health();
    if (!health.reachable) {
      stderrWriter(`reconcile needs Neo4j: ${connection.uri} unreachable: ${health.error ?? 'unknown error'}`);
      return 1;
    }
    const report = await reconcileEnrichment(connection.driver, deps.db, {
      reEnqueue: flags.reEnqueue && flags.yes,
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
    });
    deps.logger.info({ report }, 'enrichment reconciled');
    write(`episodes    ${String(report.episodes)}${report.truncated ? ' (limit reached; counts are a floor)' : ''}`);
    write(`enriched    ${String(report.enriched)}`);
    write(`queued      ${String(report.queued)}`);
    write(`unenriched  ${String(report.unenriched)}`);
    if (report.unenriched === 0) {
      return 0;
    }
    if (!flags.reEnqueue) {
      write('re-run with --re-enqueue --yes to queue them in the bulk lane');
      return 0;
    }
    if (!flags.yes) {
      write(`would re-enqueue ${String(report.unenriched)} episodes in the bulk lane; re-run with --yes`);
      return 0;
    }
    write(`re-enqueued ${String(report.reEnqueued)} episodes in the bulk lane`);
    return 0;
  } finally {
    await connection.close();
  }
}

export async function runQueue(argv: readonly string[] = [], write: Writer = stdoutWriter): Promise<number> {
  let flags: QueueFlags;
  let config: Config;
  try {
    flags = parseQueueFlags(argv);
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-queue' });
  const store = new SqliteStore({ filePath: config.sqlite.path });
  const deps: QueueDeps = { db: store.db, config, logger, write };
  try {
    if (flags.subcommand === 'reconcile') {
      return await runReconcile(deps, flags);
    }
    if (flags.subcommand === 'drop') {
      return runDrop(deps, flags);
    }
    if (flags.subcommand === 'promote') {
      return runPromote(deps, flags);
    }
    return runLs(deps, flags);
  } catch (err) {
    logger.error({ err: describeError(err) }, 'queue command failed');
    stderrWriter(describeError(err));
    return 1;
  } finally {
    store.close();
  }
}
