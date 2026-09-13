import {
  countQueueJobs,
  drainSourceIndexQueue,
  countQueueJobsByLane,
  dropUnclaimedJobs,
  INTEGRATE_JOB_TYPE,
  isReflectionLane,
  listQueueJobs,
  promoteJobs,
  reconcileEnrichment,
  REFLECTION_LANES,
  SOURCE_INDEX_JOB_TYPE,
  VECTOR_JOB_TYPE,
  sourceReadDeps,
  type ReflectionJob,
  type ReflectionLane,
  type ReflectionQueueFilter,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { ageOf } from './format.js';
import { confirmOrExit, stdoutWriter, type Writer } from './output.js';
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

const SUBCOMMANDS = ['ls', 'drop', 'promote', 'reconcile', 'index'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const DEFAULT_LIST_LIMIT = 50;

/** The two rows an acceptance writes, which is the whole population this command can act on. */
const JOB_TYPES = [INTEGRATE_JOB_TYPE, VECTOR_JOB_TYPE, SOURCE_INDEX_JOB_TYPE] as const;

const SPEC: ArgSpec<Subcommand> = {
  command: 'queue',
  usage:
    'aion queue [ls | drop | promote | reconcile | index] [--session <id>] [--lane <lane>] ' +
    '[--job-type <type>] [--limit <n>] [--re-enqueue] [--yes]',
  subcommands: SUBCOMMANDS,
  options: [
    { flag: '--session', takesValue: true },
    { flag: '--lane', takesValue: true },
    { flag: '--job-type', takesValue: true },
    { flag: '--limit', takesValue: true },
    { flag: '--re-enqueue' },
    { flag: '--yes' },
  ],
};

export type QueueFlags = {
  readonly subcommand: Subcommand;
  readonly session?: string;
  readonly lane?: ReflectionLane;
  readonly jobType?: string;
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

function jobTypeOf(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!JOB_TYPES.includes(value as (typeof JOB_TYPES)[number])) {
    throw new CliUsageError(`--job-type got '${value}', expected ${JOB_TYPES.join(' or ')}`);
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
  const jobType = jobTypeOf(values.get('--job-type'));
  const limit = limitOf(values.get('--limit'));

  if (subcommand === 'promote' && jobType === SOURCE_INDEX_JOB_TYPE) {
    throw new CliUsageError(
      `promote does not move ${SOURCE_INDEX_JOB_TYPE} rows: the index drainer claims them by ` +
        'job type rather than by lane, so promotion buys them nothing, and while they sit in ' +
        'the interactive lane `pending_ahead` reports them as work ahead of every live turn',
    );
  }

  return {
    subcommand,
    reEnqueue: flags.has('--re-enqueue'),
    yes: flags.has('--yes'),
    ...(session === undefined ? {} : { session }),
    ...(lane === undefined ? {} : { lane }),
    ...(jobType === undefined ? {} : { jobType }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function filterOf(flags: QueueFlags): ReflectionQueueFilter {
  return {
    ...(flags.session === undefined ? {} : { sessionId: flags.session }),
    ...(flags.lane === undefined ? {} : { lane: flags.lane }),
    ...(flags.jobType === undefined ? {} : { jobType: flags.jobType }),
  };
}

/**
 * What `drop` and `promote` act on, which is never the whole queue.
 *
 * Both narrow to the reflection backlog unless the operator names a type. An acceptance also
 * writes a `source_index` row that a different handler owns: dropping it destroys an obligation
 * nothing else records, and promoting it puts a row the index drainer claims by job type into the
 * one lane `pending_ahead` counts. That narrowing used to be accidental — index rows are
 * hard-coded to the bulk lane, and that literal is the only reason `pending_ahead` survived.
 */
function writeFilterOf(flags: QueueFlags): ReflectionQueueFilter {
  return { ...filterOf(flags), jobType: flags.jobType ?? INTEGRATE_JOB_TYPE };
}

/**
 * What a write will act on. The job type is always named, because the narrowing is the part an
 * operator has to see: `drop` and `promote` never reach the whole queue.
 */
function describeWriteFilter(flags: QueueFlags): string {
  const parts: string[] = [];
  if (flags.lane !== undefined) {
    parts.push(`lane=${flags.lane}`);
  }
  if (flags.session !== undefined) {
    parts.push(`session=${flags.session}`);
  }
  parts.push(`job-type=${flags.jobType ?? INTEGRATE_JOB_TYPE}`);
  return parts.join(' ');
}

/** Column widths are the widest value each field can hold: a uuid session id is 36 characters. */
export function renderQueueJobs(jobs: readonly ReflectionJob[], now: Date, write: Writer): void {
  if (jobs.length === 0) {
    write('no matching jobs');
    return;
  }
  write('lane         type         age    attempts  session                               job');
  for (const job of jobs) {
    const state = job.claimedAt === null ? '' : ' (claimed)';
    write(
      [
        job.lane.padEnd(12),
        job.jobType.padEnd(12),
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

/**
 * The matched total, then each population on its own line. The per-lane depth is the reflection
 * backlog alone: index rows are all bulk by construction, so summing them into that line reported
 * a lane flood every time the corpus grew.
 */
function renderCounts(substrate: Substrate, flags: QueueFlags): void {
  const db = substrate.db();
  const { workerMaxAttempts } = substrate.config.operational;
  const filter = filterOf(flags);
  const counts = countQueueJobs(db, filter, workerMaxAttempts);
  substrate.write('');
  substrate.write(
    `matched  ${String(counts.total)} jobs: ${String(counts.unclaimed)} unclaimed, ${String(counts.claimed)} claimed, ${String(counts.exhausted)} exhausted`,
  );
  if (flags.jobType !== SOURCE_INDEX_JOB_TYPE) {
    const byLane = countQueueJobsByLane(
      db,
      { ...filter, jobType: INTEGRATE_JOB_TYPE },
      workerMaxAttempts,
    );
    const lanes = REFLECTION_LANES.map((lane) => `${lane}=${String(byLane.get(lane) ?? 0)}`).join(
      ' ',
    );
    substrate.write(`pending  ${lanes}`);
  }
  if (flags.jobType !== INTEGRATE_JOB_TYPE) {
    const index = countQueueJobs(
      db,
      { ...filter, jobType: SOURCE_INDEX_JOB_TYPE },
      workerMaxAttempts,
    );
    substrate.write(`index    ${String(index.pending)} ${SOURCE_INDEX_JOB_TYPE} rows pending`);
    // Counted apart from the enrichment depth for the same reason: one embed call a source is
    // not the backlog a caller asking "how far behind is my turn" wants reported to it.
    const vectors = countQueueJobs(db, { ...filter, jobType: VECTOR_JOB_TYPE }, workerMaxAttempts);
    substrate.write(`vectors  ${String(vectors.pending)} ${VECTOR_JOB_TYPE} rows pending`);
  }
}

function runLs(substrate: Substrate, flags: QueueFlags): number {
  const jobs = listQueueJobs(substrate.db(), filterOf(flags), flags.limit ?? DEFAULT_LIST_LIMIT);
  renderQueueJobs(jobs, new Date(), substrate.write);
  renderCounts(substrate, flags);
  return 0;
}

async function runDrop(substrate: Substrate, flags: QueueFlags): Promise<number> {
  const db = substrate.db();
  const { write } = substrate;
  const filter = writeFilterOf(flags);
  const counts = countQueueJobs(db, filter);
  if (flags.jobType === undefined) {
    const spared = countQueueJobs(db, { ...filterOf(flags), jobType: SOURCE_INDEX_JOB_TYPE });
    if (spared.unclaimed > 0) {
      write(
        `${String(spared.unclaimed)} unclaimed ${SOURCE_INDEX_JOB_TYPE} rows are excluded: ` +
          `they are a different handler's obligation and nothing else records them. ` +
          `Pass --job-type ${SOURCE_INDEX_JOB_TYPE} to drop those instead`,
      );
    }
  }
  if (counts.unclaimed === 0) {
    write(`nothing to drop: no unclaimed jobs match ${describeWriteFilter(flags)}`);
    return 0;
  }
  write(
    `would drop ${String(counts.unclaimed)} unclaimed jobs matching ${describeWriteFilter(flags)}`,
  );
  if (counts.claimed > 0) {
    write(`${String(counts.claimed)} claimed jobs are running and are left alone`);
  }
  if (!(await confirmOrExit('drop them? [y/N] ', flags.yes, write))) {
    write('their episodes stay in the graph; re-run with --yes to drop the queue rows');
    return 0;
  }
  const dropped = dropUnclaimedJobs(db, filter);
  substrate.logger().warn({ dropped, filter }, 'reflection queue jobs dropped');
  write(`dropped ${String(dropped)} unclaimed jobs matching ${describeWriteFilter(flags)}`);
  write('their episodes are still stored; `aion queue reconcile` counts and can re-enqueue them');
  return 0;
}

function runPromote(substrate: Substrate, flags: QueueFlags): number {
  const filter = writeFilterOf(flags);
  const promoted = promoteJobs(substrate.db(), filter);
  substrate.logger().info({ promoted, filter }, 'reflection queue jobs promoted');
  substrate.write(
    `promoted ${String(promoted)} unclaimed jobs to the interactive lane (${describeWriteFilter(flags)})`,
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

/**
 * Runs the archive-index rows intake wrote. The reflection worker narrows its claim to the
 * jobs it can run, so these sit until something asks for them, and this is that something
 * until a scheduled driver owns it. A job it cannot finish goes back to the queue with the
 * reason on the row.
 */
async function runIndex(substrate: Substrate, flags: QueueFlags): Promise<number> {
  const { write } = substrate;
  const deps = sourceReadDeps({
    driver: substrate.connection().driver,
    db: substrate.db(),
    logger: substrate.logger(),
  });
  const drain = await drainSourceIndexQueue(deps, {
    ...(flags.limit === undefined ? {} : { maxJobs: flags.limit }),
  });
  substrate.logger().info({ drain }, 'source index queue drained');
  write(`claimed     ${String(drain.claimed)}`);
  write(`completed   ${String(drain.completed)}`);
  write(`documents   ${String(drain.documents)}`);
  write(`deferred    ${String(drain.deferred)}`);
  if (drain.deferred > 0) {
    write('deferred rows keep their obligation; `aion queue ls` shows the reason on each');
  }
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
      if (flags.subcommand === 'index') {
        return await runIndex(substrate, flags);
      }
      if (flags.subcommand === 'drop') {
        return await runDrop(substrate, flags);
      }
      if (flags.subcommand === 'promote') {
        return runPromote(substrate, flags);
      }
      return runLs(substrate, flags);
    },
  });
}
