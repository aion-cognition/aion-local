import {
  ConfigError,
  GraphConnection,
  loadConfig,
  openLogger,
  SqliteStore,
  type Config,
  type Logger,
  type SqliteHandle,
} from '@aion/core';

import { CliUsageError, wantsHelp, type ArgSpec } from './args.js';
import { describeError, stderrWriter, type Writer } from './output.js';

/**
 * The lifecycle every command shares: validated config, a logger, a database, a graph driver,
 * and the guarantee that each is closed however the command ends. Each opens on first use, so
 * a command that answers out of its own catalog opens no log file and no database, and one
 * refused for a bad flag opens neither before it refuses.
 */
export class Substrate {
  readonly config: Config;
  readonly write: Writer;
  readonly #name: string;
  #logger: Logger | undefined;
  #store: SqliteStore | undefined;
  #connection: GraphConnection | undefined;

  constructor(config: Config, name: string, write: Writer) {
    this.config = config;
    this.#name = name;
    this.write = write;
  }

  logger(): Logger {
    const open = this.#logger;
    if (open !== undefined) {
      return open;
    }
    const logger = openLogger({ ...this.config.logging, name: `aion-${this.#name}` });
    this.#logger = logger;
    return logger;
  }

  db(): SqliteHandle {
    const open = this.#store;
    if (open !== undefined) {
      return open.db;
    }
    const store = new SqliteStore({ filePath: this.config.sqlite.path });
    this.#store = store;
    return store.db;
  }

  connection(): GraphConnection {
    const open = this.#connection;
    if (open !== undefined) {
      return open;
    }
    const connection = new GraphConnection(this.config.neo4j);
    this.#connection = connection;
    return connection;
  }

  /**
   * The reachability guard, named by the operation that needed Bolt rather than by the process
   * that opened the driver: a refusal is read by whoever typed the command.
   */
  async requireGraph(subject: string): Promise<GraphConnection | undefined> {
    const connection = this.connection();
    const health = await connection.health();
    if (health.reachable) {
      return connection;
    }
    stderrWriter(
      `${subject} needs Neo4j: ${connection.uri} unreachable: ${health.error ?? 'unknown error'}`,
    );
    return undefined;
  }

  /** The driver goes first, since work still draining on it can read and write the database. */
  async close(): Promise<void> {
    if (this.#connection !== undefined) {
      await this.#connection.close();
    }
    if (this.#store !== undefined) {
      this.#store.close();
    }
  }
}

export type SubstrateCommand<F> = {
  readonly spec: ArgSpec;
  readonly argv: readonly string[];
  readonly write: Writer;
  readonly parse: (argv: readonly string[]) => F;
  readonly run: (substrate: Substrate, flags: F) => Promise<number>;
  /** Names the command in the refusal when Bolt has to answer before `run` starts. */
  readonly needsGraph?: string;
};

/** A usage error prints what the command accepts; anything else prints only what went wrong. */
function report(spec: ArgSpec, err: unknown): void {
  if (err instanceof CliUsageError) {
    stderrWriter(err.message);
    stderrWriter(`usage: ${spec.usage}`);
    return;
  }
  stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
}

export async function withSubstrate<F>(command: SubstrateCommand<F>): Promise<number> {
  const { spec, argv, write } = command;
  if (wantsHelp(argv)) {
    write(`usage: ${spec.usage}`);
    return 0;
  }

  let flags: F;
  let config: Config;
  try {
    flags = command.parse(argv);
    config = loadConfig(process.env);
  } catch (err) {
    report(spec, err);
    return 1;
  }

  const substrate = new Substrate(config, spec.command, write);
  try {
    if (command.needsGraph !== undefined) {
      const connection = await substrate.requireGraph(command.needsGraph);
      if (connection === undefined) {
        return 1;
      }
    }
    return await command.run(substrate, flags);
  } catch (err) {
    substrate.logger().error({ err: describeError(err) }, `${spec.command} failed`);
    report(spec, err);
    return 1;
  } finally {
    await substrate.close();
  }
}
