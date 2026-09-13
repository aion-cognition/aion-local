import {
  ApiUsageRecorder,
  GenerationSpendGuard,
  introspectionOperations,
  markLedgerApplied,
  observeHealth,
  operationBucketKey,
  ProviderRouter,
  type Config,
  type IntrospectionOperation,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { lifecycleNarrativeDeps } from './lifecycle.js';
import { stdoutWriter, type Writer } from './output.js';
import { abortOnInterrupt } from './replay.js';
import { withSubstrate, type Substrate } from './substrate.js';

/**
 * `aion maintain`: the human window onto the introspection loop, and the one way to make a
 * maintenance operation run now.
 *
 * The loop decides for itself which operation each tick is worth spending, which is the design
 * and is right almost always. It is wrong in one case: a person knows something the health
 * snapshot cannot express. A leaked credential is the example that forced this command to
 * exist. Thirteen leaking nodes out of two thousand is a small number to a scoring function and
 * an incident to a person, and before this there was no way to say so.
 *
 * A forced run bypasses the relevance score and the bucket claim, and nothing else. The bucket
 * claim exists to arbitrate between two service instances that both decided to run the same
 * operation in the same window; a person asking by name is the authority it was arbitrating on
 * behalf of, so they get their run. Everything else holds: the operation's own batch bounds,
 * its transactions, the protected relationship set, and the ledger record.
 */

const SUBCOMMANDS = ['ls', 'run'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const SPEC: ArgSpec<Subcommand> = {
  command: 'maintain',
  usage: 'aion maintain [ls | run <operation>]',
  subcommands: SUBCOMMANDS,
  maxPositionals: 1,
};

export type MaintainFlags = {
  readonly subcommand: Subcommand;
  readonly operation?: string;
};

export function parseMaintainFlags(argv: readonly string[]): MaintainFlags {
  const { subcommand, positionals } = parseArgs(SPEC, argv);
  const [operation] = positionals;
  if (subcommand === 'run' && operation === undefined) {
    throw new CliUsageError('maintain run needs an operation name (see `aion maintain ls`)');
  }
  return { subcommand, ...(operation === undefined ? {} : { operation }) };
}

function describeOperation(operation: IntrospectionOperation): string {
  const answers =
    operation.answers === undefined ? 'routine' : `critical responder for ${operation.answers}`;
  return `  ${operation.name}  ${operation.bucket} window, ${answers}`;
}

function runLs(write: Writer, config: Config): number {
  const operations = introspectionOperations(config);
  write(`registered maintenance operations (${String(operations.length)})`);
  for (const operation of operations) {
    write(describeOperation(operation));
  }
  write('');
  write('`aion maintain run <name>` runs one now, whatever the loop would have chosen');
  return 0;
}

async function runOne(substrate: Substrate, name: string): Promise<number> {
  const operations = introspectionOperations(substrate.config);
  const operation = operations.find((entry) => entry.name === name);
  if (operation === undefined) {
    throw new CliUsageError(
      `no maintenance operation named '${name}' (registered: ${operations
        .map((entry) => entry.name)
        .join(', ')})`,
    );
  }

  const { config, write } = substrate;
  const db = substrate.db();
  const logger = substrate.logger();
  const connection = substrate.connection();
  const { driver } = connection;
  const now = new Date();
  // The second driver path has to be the same path. Composed for every forced run rather than
  // for the operations that name it, because which of them publishes is the catalog's business
  // and a command that guessed would be a second answer to it.
  const narratives = await lifecycleNarrativeDeps({ connection, db, logger });
  // The same reading a tick would have taken. An operation is contracted never to observe for
  // itself, so a forced run has to arrive holding one.
  const health = await observeHealth({ driver, db, config, logger });
  if (health.degraded.length > 0) {
    write(`health collectors that fell back: ${health.degraded.join(', ')}`);
  }

  // A forced run can be a big backlog (redaction_residue_purge, say), and an operator who
  // Ctrl-Cs it should stop the batch loop cleanly rather than kill the substrate mid-write.
  const controller = abortOnInterrupt();
  const outcome = await operation.run({
    driver,
    db,
    config,
    logger,
    // One forced run, so the breaker this router builds has nothing to count across; the
    // service's loop is where sharing one matters.
    provider: new ProviderRouter({
      config,
      recordApiCall: new ApiUsageRecorder(db, logger).recordApiCall,
      // The forced run holds against the same day's ceiling the service does. The ledger is the
      // substrate's own table, so an operator forcing an operation while the service runs cannot
      // spend the day twice.
      spending: new GenerationSpendGuard({ db, ceilingUsd: config.anthropic.dailyCeilingUsd }),
    }).forRole('reflect'),
    narratives,
    health,
    now,
    signal: controller.signal,
  });

  markLedgerApplied(db, operationBucketKey(operation.name, operation.bucket, now), {
    operation: operation.name,
    forced: true,
    status: outcome.status,
    itemsProcessed: outcome.itemsProcessed,
    itemsAffected: outcome.itemsAffected,
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  });
  logger.warn(
    {
      operation: operation.name,
      forced: true,
      status: outcome.status,
      itemsProcessed: outcome.itemsProcessed,
      itemsAffected: outcome.itemsAffected,
    },
    'maintenance operation forced by an operator',
  );

  write(
    `${operation.name}: ${outcome.status}, ` +
      `${String(outcome.itemsAffected)} of ${String(outcome.itemsProcessed)} affected`,
  );
  if (outcome.detail !== undefined) {
    write(`  ${outcome.detail}`);
  }
  return outcome.status === 'failed' ? 1 : 0;
}

export function runMaintain(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseMaintainFlags,
    run: async (substrate, flags) => {
      // The catalog is a compiled-in list, so `ls` answers without a log file, a database, or
      // a graph driver, on a machine where none of the three exists yet.
      if (flags.subcommand === 'ls') {
        return runLs(write, substrate.config);
      }
      const connection = await substrate.requireGraph('maintain');
      if (connection === undefined) {
        return 1;
      }
      return await runOne(substrate, flags.operation ?? '');
    },
  });
}
