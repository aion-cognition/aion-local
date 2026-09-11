import {
  ApiUsageRecorder,
  CHUNK_BOUNDARY_POLICY,
  NARRATIVE_MIGRATION_LIMITS,
  openReadOnlySqliteHandle,
  PARTITION_POLICY_VERSION,
  ProviderRouter,
  readNarrativeMigration,
  runNarrativeMigrationBatch,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { lifecycleNarrativeDeps } from './lifecycle.js';
import { stdoutWriter, type Writer } from './output.js';
import { abortOnInterrupt } from './replay.js';
import { withSubstrate } from './substrate.js';

const SPEC: ArgSpec<'status' | 'run'> = {
  command: 'consolidate',
  usage: 'aion consolidate [status | run] --cohort <id> [--steps <n>] [--refresh] [--json]',
  subcommands: ['status', 'run'],
  options: [
    { flag: '--cohort', takesValue: true },
    { flag: '--steps', takesValue: true },
    { flag: '--refresh' },
    { flag: '--json' },
  ],
};

export function parseConsolidateFlags(argv: readonly string[]) {
  const normalized = argv[0] === undefined || argv[0].startsWith('-') ? ['status', ...argv] : argv;
  const args = parseArgs(SPEC, normalized);
  const cohortId = args.values.get('--cohort');
  if (cohortId === undefined || cohortId.trim() === '') {
    throw new CliUsageError('consolidate requires --cohort <id>');
  }
  const steps = Number(args.values.get('--steps') ?? NARRATIVE_MIGRATION_LIMITS.steps);
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > 256) {
    throw new CliUsageError('--steps must be a whole number between 1 and 256');
  }
  if (args.subcommand === 'status' && (args.flags.has('--refresh') || args.values.has('--steps'))) {
    throw new CliUsageError('--steps and --refresh apply to consolidate run');
  }
  return {
    action: args.subcommand,
    cohortId,
    steps,
    refresh: args.flags.has('--refresh'),
    json: args.flags.has('--json'),
  };
}

/** Status opens only a read-only handle. Run advances one bounded batch under the existing coordinator. */
export function runConsolidate(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseConsolidateFlags,
    run: async (substrate, flags) => {
      if (flags.action === 'status') {
        const db = openReadOnlySqliteHandle({ filePath: substrate.config.sqlite.path });
        try {
          const job = readNarrativeMigration(db, flags.cohortId);
          const line =
            job === undefined
              ? `no migration named ${flags.cohortId}`
              : `${job.cohortId}: ${job.phase}, checkpoint ${String(job.revision)}`;
          write(flags.json ? JSON.stringify({ job: job ?? null }) : line);
          return job === undefined ? 1 : 0;
        } finally {
          db.close();
        }
      }
      const connection = await substrate.requireGraph('consolidate run');
      if (connection === undefined) {
        return 1;
      }
      const db = substrate.db();
      const logger = substrate.logger();
      const shared = await lifecycleNarrativeDeps({ connection, db, logger });
      const provider = new ProviderRouter({
        config: substrate.config,
        recordApiCall: new ApiUsageRecorder(db, logger).recordApiCall,
      }).forRole('reflect');
      const result = await runNarrativeMigrationBatch(
        { ...shared, driver: connection.driver, db, logger, provider },
        {
          cohortId: flags.cohortId,
          steps: flags.steps,
          refresh: flags.refresh,
          now: new Date(),
          signal: abortOnInterrupt().signal,
          policy: {
            ...CHUNK_BOUNDARY_POLICY,
            renderedInputAllowance: substrate.config.maintenance.chunkRenderedInputAllowance,
            maxSpanMs: substrate.config.maintenance.chunkMaxSpanMs,
            partitionPolicyVersion: PARTITION_POLICY_VERSION,
          },
        },
      );
      write(
        flags.json
          ? JSON.stringify(result)
          : `${result.cohortId}: ${result.phase}; ${String(result.steps)} steps, ` +
              `${String(result.sealed)} chunks sealed, ${String(result.published)} published, ${String(result.cutovers)} cutovers`,
      );
      if (!flags.json) {
        for (const issue of result.issues) {
          write(`  ${issue.id}: ${issue.reason}`);
        }
        if (result.stopped !== undefined) {
          write(`  stopped: ${result.stopped}`);
        }
      }
      return result.stopped === undefined ||
        result.stopped === 'between_steps_budget' ||
        result.stopped === 'aborted'
        ? 0
        : 1;
    },
  });
}
