import {
  ConfigError,
  GraphConnection,
  introspectionOperations,
  loadConfig,
  markLedgerApplied,
  observeHealth,
  openLogger,
  operationBucketKey,
  SqliteStore,
  type Config,
  type IntrospectionOperation,
  type Logger,
} from '@aion/core';

import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

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

export class UnknownMaintainSubcommandError extends Error {
  constructor(name: string) {
    super(`unknown maintain subcommand '${name}' (supported: ${SUBCOMMANDS.join(', ')})`);
    this.name = 'UnknownMaintainSubcommandError';
  }
}

export class MissingOperationNameError extends Error {
  constructor() {
    super('maintain run needs an operation name (see `aion maintain ls`)');
    this.name = 'MissingOperationNameError';
  }
}

export class UnknownOperationError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(`no maintenance operation named '${name}' (registered: ${known.join(', ')})`);
    this.name = 'UnknownOperationError';
  }
}

export type MaintainFlags = {
  readonly subcommand: Subcommand;
  readonly operation?: string;
};

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export function parseMaintainFlags(argv: readonly string[]): MaintainFlags {
  const [first = 'ls', ...rest] = argv;
  if (!isSubcommand(first)) {
    throw new UnknownMaintainSubcommandError(first);
  }
  const operation = rest.find((arg) => !arg.startsWith('--'));
  if (first === 'run' && operation === undefined) {
    throw new MissingOperationNameError();
  }
  return { subcommand: first, ...(operation === undefined ? {} : { operation }) };
}

function describeOperation(operation: IntrospectionOperation): string {
  const answers =
    operation.answers === undefined ? 'routine' : `critical responder for ${operation.answers}`;
  return `  ${operation.name}  ${operation.bucket} window, ${answers}`;
}

function runLs(write: Writer): number {
  const operations = introspectionOperations();
  write(`registered maintenance operations (${String(operations.length)})`);
  for (const operation of operations) {
    write(describeOperation(operation));
  }
  write('');
  write('`aion maintain run <name>` runs one now, whatever the loop would have chosen');
  return 0;
}

type MaintainDeps = {
  readonly connection: GraphConnection;
  readonly store: SqliteStore;
  readonly config: Config;
  readonly logger: Logger;
  readonly write: Writer;
};

async function runOne(deps: MaintainDeps, name: string): Promise<number> {
  const operations = introspectionOperations();
  const operation = operations.find((entry) => entry.name === name);
  if (operation === undefined) {
    throw new UnknownOperationError(
      name,
      operations.map((entry) => entry.name),
    );
  }

  const now = new Date();
  // The same reading a tick would have taken. An operation is contracted never to observe for
  // itself, so a forced run has to arrive holding one.
  const health = await observeHealth({
    driver: deps.connection.driver,
    db: deps.store.db,
    config: deps.config,
    logger: deps.logger,
  });
  if (health.degraded.length > 0) {
    deps.write(`health collectors that fell back: ${health.degraded.join(', ')}`);
  }

  const controller = new AbortController();
  const outcome = await operation.run({
    driver: deps.connection.driver,
    db: deps.store.db,
    config: deps.config,
    logger: deps.logger,
    health,
    now,
    signal: controller.signal,
  });

  markLedgerApplied(deps.store.db, operationBucketKey(operation.name, operation.bucket, now), {
    operation: operation.name,
    forced: true,
    status: outcome.status,
    itemsProcessed: outcome.itemsProcessed,
    itemsAffected: outcome.itemsAffected,
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  });
  deps.logger.warn(
    {
      operation: operation.name,
      forced: true,
      status: outcome.status,
      itemsProcessed: outcome.itemsProcessed,
      itemsAffected: outcome.itemsAffected,
    },
    'maintenance operation forced by an operator',
  );

  deps.write(
    `${operation.name}: ${outcome.status}, ` +
      `${String(outcome.itemsAffected)} of ${String(outcome.itemsProcessed)} affected`,
  );
  if (outcome.detail !== undefined) {
    deps.write(`  ${outcome.detail}`);
  }
  return outcome.status === 'failed' ? 1 : 0;
}

export async function runMaintain(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  let flags: MaintainFlags;
  let config: Config;
  try {
    flags = parseMaintainFlags(argv);
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  if (flags.subcommand === 'ls') {
    return runLs(write);
  }

  const logger = openLogger({ ...config.logging, name: 'aion-maintain' });
  const store = new SqliteStore({ filePath: config.sqlite.path });
  const connection = new GraphConnection(config.neo4j);
  try {
    const health = await connection.health();
    if (!health.reachable) {
      stderrWriter(
        `maintain needs Neo4j: ${connection.uri} unreachable: ${health.error ?? 'unknown error'}`,
      );
      return 1;
    }
    return await runOne({ connection, store, config, logger, write }, flags.operation ?? '');
  } catch (err) {
    logger.error({ err: describeError(err) }, 'maintain command failed');
    stderrWriter(describeError(err));
    return 1;
  } finally {
    await connection.close();
    store.close();
  }
}
