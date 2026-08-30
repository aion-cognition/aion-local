import {
  countQueueJobs,
  countQueueJobsByLane,
  dropUnclaimedJobs,
  isReflectionLane,
  listQueueJobs,
  promoteJobs,
  reconcileEnrichment,
  REFLECTION_LANES,
  type ReflectionJob,
  type ReflectionLane,
  type ReflectionQueueFilter,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { ageOf } from './format.js';
import { stdoutWriter, type Writer } from './output.js';
import { withSubstrate, type Substrate } from './substrate.js';

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

const SPEC: ArgSpec<Subcommand> = {
  command: 'queue',
  usage:
    'aion queue [ls | drop | promote | reconcile] [--session <id>] [--lane <lane>] ' +
    '[--limit <n>] [--re-enqueue] [--yes]',
  subcommands: SUBCOMMANDS,
  options: [
    { flag: '--session', takesValue: true },
    { flag: '--lane', takesValue: true },
    { flag: '--limit', takesValue: true },
    { flag: '--re-enqueue' },
    { flag: '--yes' },
  ],
};

export type QueueFlags = {
  readonly subcommand: Subcommand;
  readonly session?: string;
  readonly lane?: ReflectionLane;
  readonly limit?: number;
  readonly reEnqueue: boolean;
  readonly yes: boolean;
};

function laneOf(value: string | undefined): ReflectionLane | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isReflectionLane(value)) {
    throw new CliUsageError(`--lane got '${value}', expected ${REFLECTION_LANES.join(' or ')}`);
  }
  return value;
}

/** A limit of zero or a fraction reads as a typo, and both would silently list nothing. */
function limitOf(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`--limit got '${value}', expected a positive integer`);
  }
  return parsed;
}

export function parseQueueFlags(argv: readonly string[]): QueueFlags {
  const { subcommand, flags, values } = parseArgs(SPEC, argv);
  const session = values.get('--session');
  const lane = laneOf(values.get('--lane'));
  const limit = limitOf(values.get('--limit'));

  return {
    subcommand,
    reEnqueue: flags.has('--re-enqueue'),
    yes: flags.has('--yes'),
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
        ageOf(now.getTime() - new Date(job.enqueuedAt).getTime()).padStart(5),
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

function renderCounts(substrate: Substrate, flags: QueueFlags): void {
  const db = substrate.db();
  const { workerMaxAttempts } = substrate.config.operational;
  const counts = countQueueJobs(db, filterOf(flags), workerMaxAttempts);
  const byLane = countQueueJobsByLane(db, workerMaxAttempts);
  const lanes = REFLECTION_LANES.map((lane) => `${lane}=${String(byLane.get(lane) ?? 0)}`).join(
    ' ',
  );
  substrate.write('');
  substrate.write(
    `matched  ${String(counts.total)} jobs: ${String(counts.unclaimed)} unclaimed, ${String(counts.claimed)} claimed, ${String(counts.exhausted)} exhausted`,
  );
  substrate.write(`pending  ${lanes}`);
}

function runLs(substrate: Substrate, flags: QueueFlags): number {
  const jobs = listQueueJobs(substrate.db(), filterOf(flags), flags.limit ?? DEFAULT_LIST_LIMIT);
  renderQueueJobs(jobs, new Date(), substrate.write);
  renderCounts(substrate, flags);
  return 0;
}

function runDrop(substrate: Substrate, flags: QueueFlags): number {
  const db = substrate.db();
  const { write } = substrate;
  const counts = countQueueJobs(db, filterOf(flags));
  if (counts.unclaimed === 0) {
    write(`nothing to drop: no unclaimed jobs match ${describeFilter(flags)}`);
    return 0;
  }
  if (!flags.yes) {
    write(
      `would drop ${String(counts.unclaimed)} unclaimed jobs matching ${describeFilter(flags)}`,
    );
    if (counts.claimed > 0) {
      write(`${String(counts.claimed)} claimed jobs are running and are left alone`);
    }
    write('their episodes stay in the graph; re-run with --yes to drop the queue rows');
    return 0;
  }
  const dropped = dropUnclaimedJobs(db, filterOf(flags));
  substrate.logger().warn({ dropped, filter: filterOf(flags) }, 'reflection queue jobs dropped');
  write(`dropped ${String(dropped)} unclaimed jobs matching ${describeFilter(flags)}`);
  write('their episodes are still stored; `aion queue reconcile` counts and can re-enqueue them');
  return 0;
}

function runPromote(substrate: Substrate, flags: QueueFlags): number {
  const promoted = promoteJobs(substrate.db(), filterOf(flags));
  substrate.logger().info({ promoted, filter: filterOf(flags) }, 'reflection queue jobs promoted');
  substrate.write(
    `promoted ${String(promoted)} unclaimed jobs to the interactive lane (${describeFilter(flags)})`,
  );
  return 0;
}

async function runReconcile(substrate: Substrate, flags: QueueFlags): Promise<number> {
  const { write } = substrate;
  const connection = await substrate.requireGraph('reconcile');
  if (connection === undefined) {
    return 1;
  }
  const report = await reconcileEnrichment(connection.driver, substrate.db(), {
    reEnqueue: flags.reEnqueue && flags.yes,
    ...(flags.limit === undefined ? {} : { limit: flags.limit }),
  });
  substrate.logger().info({ report }, 'enrichment reconciled');
  write(
    `episodes    ${String(report.episodes)}${report.truncated ? ' (limit reached; counts are a floor)' : ''}`,
  );
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
    write(
      `would re-enqueue ${String(report.unenriched)} episodes in the bulk lane; re-run with --yes`,
    );
    return 0;
  }
  write(`re-enqueued ${String(report.reEnqueued)} episodes in the bulk lane`);
  return 0;
}

export function runQueue(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseQueueFlags,
    run: async (substrate, flags) => {
      if (flags.subcommand === 'reconcile') {
        return await runReconcile(substrate, flags);
      }
      if (flags.subcommand === 'drop') {
        return runDrop(substrate, flags);
      }
      if (flags.subcommand === 'promote') {
        return runPromote(substrate, flags);
      }
      return runLs(substrate, flags);
    },
  });
}
