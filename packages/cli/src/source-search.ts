import { runSourceSearch, searchOutputFor, searchText, sourceReadDeps } from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion source-search`: literal text against the captured archive, not the seed layer.
 *
 * `aion search` stays what it was, a window on the vector and graph retrieval recall uses.
 * This one asks a different question: which raw part actually contains this phrase, whether or
 * not anything was ever extracted from it and whether or not its projection still exists. The
 * answer carries what the corpus could not cover, so an empty page is never read as an absence.
 */

const SPEC: ArgSpec = {
  command: 'source-search',
  usage:
    'aion source-search <query> [--limit <n>] [--cursor <c>] [--as-of <ts>] [--knew-at <ts>] [--json]',
  options: [
    { flag: '--limit', takesValue: true },
    { flag: '--cursor', takesValue: true },
    { flag: '--as-of', takesValue: true },
    { flag: '--knew-at', takesValue: true },
    { flag: '--json' },
  ],
  maxPositionals: Number.POSITIVE_INFINITY,
};

export type SourceSearchFlags = {
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly asOf?: string;
  readonly knewAt?: string;
  readonly json: boolean;
};

function count(values: ReadonlyMap<string, string>, option: string): number | undefined {
  const value = values.get(option);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${option} got '${value}', expected a whole number of at least 1`);
  }
  return parsed;
}

export function parseSourceSearchFlags(argv: readonly string[]): SourceSearchFlags {
  const { flags, values, positionals } = parseArgs(SPEC, argv);
  const query = positionals.join(' ');
  if (query.trim().length === 0) {
    throw new CliUsageError('source-search needs a query: `aion source-search "<phrase>"`');
  }
  const limit = count(values, '--limit');
  const cursor = values.get('--cursor');
  const asOf = values.get('--as-of');
  const knewAt = values.get('--knew-at');
  return {
    query,
    json: flags.has('--json'),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(asOf === undefined ? {} : { asOf }),
    ...(knewAt === undefined ? {} : { knewAt }),
  };
}

/**
 * A refusal, an unavailable capability and a bad request are non-zero: a script that pipes this
 * into something else must not read "search cannot run here" as "nothing matched".
 */
function exitFor(status: string): number {
  return status === 'results' ? 0 : 1;
}

export function runSourceSearchCommand(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseSourceSearchFlags,
    run: async (substrate, flags) => {
      const deps = sourceReadDeps({
        driver: substrate.connection().driver,
        db: substrate.db(),
        logger: substrate.logger(),
      });
      const outcome = await runSourceSearch(deps, {
        query: flags.query,
        ...(flags.limit === undefined ? {} : { limit: flags.limit }),
        ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
        ...(flags.asOf === undefined ? {} : { asOf: flags.asOf }),
        ...(flags.knewAt === undefined ? {} : { knewAt: flags.knewAt }),
      });
      const output = searchOutputFor(outcome);
      write(flags.json ? JSON.stringify(output) : searchText(output));
      if (output.status === 'results' && output.continuation !== undefined && !flags.json) {
        write(`  continue with --cursor ${output.continuation}`);
      }
      return exitFor(output.status);
    },
  });
}
