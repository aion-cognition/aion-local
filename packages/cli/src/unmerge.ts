import {
  ConfigError,
  GraphConnection,
  listUnmergeableRecords,
  loadConfig,
  openLogger,
  runEntityUnmerge,
  SqliteStore,
  type Config,
} from '@aion/core';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

/**
 * `aion unmerge`: the human end of entity deduplication.
 *
 * Dedup merges two entities when it judges them the same identity, and it is sometimes wrong.
 * The repair is deliberately not a maintenance operation: a bad merge is not measurable from
 * inside the graph, since the shape after a correct merge and after a wrong one is the same,
 * and the only thing that separates them is a person saying the two names were different
 * things. So the loop never selects it, and this command is where that person says so.
 *
 * `ls <canonical-id>` shows what one entity has absorbed, which is what a decision needs.
 * `apply <merged-id>` splits one of those identities back out.
 */

const SUBCOMMANDS = ['ls', 'apply'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

export class UnknownUnmergeSubcommandError extends Error {
  constructor(name: string) {
    super(`unknown unmerge subcommand '${name}' (supported: ${SUBCOMMANDS.join(', ')})`);
    this.name = 'UnknownUnmergeSubcommandError';
  }
}

export class MissingUnmergeIdError extends Error {
  constructor(subcommand: string) {
    const needs = subcommand === 'ls' ? 'a canonical entity id' : 'the absorbed entity id';
    super(`unmerge ${subcommand} needs ${needs}`);
    this.name = 'MissingUnmergeIdError';
  }
}

export type UnmergeFlags = {
  readonly subcommand: Subcommand;
  readonly id: string;
};

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export function parseUnmergeFlags(argv: readonly string[]): UnmergeFlags {
  const [first = 'ls', ...rest] = argv;
  if (!isSubcommand(first)) {
    throw new UnknownUnmergeSubcommandError(first);
  }
  const id = rest.find((arg) => !arg.startsWith('--'));
  if (id === undefined) {
    throw new MissingUnmergeIdError(first);
  }
  return { subcommand: first, id };
}

function short(id: string): string {
  return id.slice(0, 8);
}

export async function runUnmerge(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  let flags: UnmergeFlags;
  let config: Config;
  try {
    flags = parseUnmergeFlags(argv);
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-unmerge' });
  const store = new SqliteStore({ filePath: config.sqlite.path });
  const connection = new GraphConnection(config.neo4j);
  try {
    const health = await connection.health();
    if (!health.reachable) {
      stderrWriter(
        `unmerge needs Neo4j: ${connection.uri} unreachable: ${health.error ?? 'unknown error'}`,
      );
      return 1;
    }

    if (flags.subcommand === 'ls') {
      const records = await listUnmergeableRecords(connection.driver, flags.id);
      write(`${short(flags.id)} has absorbed ${String(records.length)} identity(ies)`);
      for (const record of records) {
        write(
          `  ${record.mergedId}  ${record.mergedName ?? 'name not recorded'}` +
            ` (${record.mergedType ?? 'type not recorded'}), ` +
            `${String(record.edges.length)} edge(s) recorded`,
        );
      }
      if (records.length > 0) {
        write('');
        write('`aion unmerge apply <id>` splits one of them back out');
      }
      return 0;
    }

    const report = await runEntityUnmerge(
      { driver: connection.driver, db: store.db, logger },
      { mergedId: flags.id },
    );
    write(`${flags.id}: ${report.status}, ${report.detail}`);
    if (report.restoredId !== undefined) {
      write(`  restored as ${report.restoredId} out of ${short(report.canonicalId ?? '')}`);
      write(`  ${String(report.aliasesReleased)} alias(es) released`);
    }
    return 0;
  } catch (err) {
    logger.error({ err: describeError(err) }, 'unmerge command failed');
    stderrWriter(describeError(err));
    return 1;
  } finally {
    await connection.close();
    store.close();
  }
}
