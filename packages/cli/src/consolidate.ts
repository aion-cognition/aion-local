import {
  ApiUsageRecorder,
  abandonNarrativeMigration,
  MigrationRefused,
  CHUNK_BOUNDARY_POLICY,
  NARRATIVE_MIGRATION_LIMITS,
  PARTITION_POLICY_VERSION,
  ProviderRouter,
  readNarrativeMigration,
  runNarrativeMigrationBatch,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { inspectMigration, writeMigrationStatus } from './consolidate-status.js';
import { lifecycleNarrativeDeps } from './lifecycle.js';
import { stdoutWriter, type Writer } from './output.js';
import { abortOnInterrupt } from './replay.js';
import { withSubstrate } from './substrate.js';

const SPEC: ArgSpec<'status' | 'run' | 'abandon'> = {
  command: 'consolidate',
  usage:
    'aion consolidate [status | run | abandon] --cohort <id> [--steps <n>] [--refresh | --reverify] [--json]',
  subcommands: ['status', 'run', 'abandon'],
  options: [
    { flag: '--cohort', takesValue: true },
    { flag: '--steps', takesValue: true },
    { flag: '--refresh' },
    { flag: '--reverify' },
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
  if (
    args.subcommand !== 'run' &&
    (args.flags.has('--refresh') || args.flags.has('--reverify') || args.values.has('--steps'))
  ) {
    throw new CliUsageError('--steps, --refresh and --reverify apply to consolidate run');
  }
  if (args.flags.has('--refresh') && args.flags.has('--reverify')) {
    throw new CliUsageError('choose --refresh or --reverify, not both');
  }
  return {
    action: args.subcommand,
    cohortId,
    steps,
    refresh: args.flags.has('--refresh'),
    reverify: args.flags.has('--reverify'),
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
      const status = inspectMigration(substrate.config.sqlite.path, flags.cohortId);
      if (flags.action === 'status') {
        writeMigrationStatus(status, flags.json, write);
        return status.status === 'read' && status.job.state !== 'blocked' ? 0 : 1;
      }
      if (flags.action === 'abandon') {
        if (status.status !== 'read') {
          writeMigrationStatus(status, flags.json, write);
          return 1;
        }
        abandonNarrativeMigration(substrate.db(), flags.cohortId, new Date());
        writeMigrationStatus(
          inspectMigration(substrate.config.sqlite.path, flags.cohortId),
          flags.json,
          write,
        );
        return 0;
      }
      if (status.status === 'unavailable') {
        writeMigrationStatus(status, flags.json, write);
        return 1;
      }
      if (
        status.status === 'read' &&
        (status.job.state === 'abandoned' ||
          status.job.blockedReason === 'capture_member_bound' ||
          (!flags.refresh && !flags.reverify && status.job.state !== 'running'))
      ) {
        writeMigrationStatus(status, flags.json, write);
        return status.job.state === 'complete' ? 0 : 1;
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
      let result;
      try {
        result = await runNarrativeMigrationBatch(
          { ...shared, driver: connection.driver, db, logger, provider },
          {
            cohortId: flags.cohortId,
            steps: flags.steps,
            refresh: flags.refresh,
            reverify: flags.reverify,
            now: new Date(),
            signal: abortOnInterrupt().signal,
            policy: readNarrativeMigration(db, flags.cohortId)?.policy ?? {
              ...CHUNK_BOUNDARY_POLICY,
              renderedInputAllowance: substrate.config.maintenance.chunkRenderedInputAllowance,
              maxSpanMs: substrate.config.maintenance.chunkMaxSpanMs,
              partitionPolicyVersion: PARTITION_POLICY_VERSION,
            },
          },
        );
      } catch (error) {
        if (!(error instanceof MigrationRefused)) {
          throw error;
        }
        write(
          flags.json
            ? JSON.stringify({
                status: 'refused',
                cohortId: flags.cohortId,
                issue: { id: error.id, reason: error.reason },
              })
            : error.message,
        );
        return 1;
      }

      write(
        flags.json
          ? JSON.stringify(result)
          : `${result.cohortId}: ${result.state}, ${result.phase}; ${String(result.steps)} steps, ` +
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
      return result.state !== 'blocked' &&
        result.state !== 'abandoned' &&
        (result.stopped === undefined ||
          result.stopped === 'batch_wall_budget' ||
          result.stopped === 'aborted')
        ? 0
        : 1;
    },
  });
}
