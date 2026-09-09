import { runSourceInspection, sourceOutputFor, sourceReadDeps, sourceText } from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion source <id>`: the captured parts behind one source id, one original turn id, or one
 * part address. It answers from the records and the archive, so an id from a saved pack still
 * resolves after the graph projection is gone.
 */

const SPEC: ArgSpec = {
  command: 'source',
  usage: 'aion source <id | source:kind:ordinal> [--limit <n>] [--cursor <c>] [--json]',
  options: [
    { flag: '--limit', takesValue: true },
    { flag: '--cursor', takesValue: true },
    { flag: '--as-of', takesValue: true },
    { flag: '--knew-at', takesValue: true },
    { flag: '--json' },
  ],
  maxPositionals: 1,
};

export type SourceFlags = {
  readonly id?: string;
  readonly part?: {
    readonly sourceId: string;
    readonly partKind: string;
    readonly ordinal: number;
  };
  readonly limit?: number;
  readonly cursor?: string;
  readonly asOf?: string;
  readonly knewAt?: string;
  readonly json: boolean;
};

const PART_ADDRESS = /^(.+):(turn|observation|tool_execution):(\d+)$/;

export function parseSourceFlags(argv: readonly string[]): SourceFlags {
  const { flags, values, positionals } = parseArgs(SPEC, argv);
  const [target] = positionals;
  if (target === undefined || target.trim().length === 0) {
    throw new CliUsageError('source needs an id: `aion source <id>` (see `aion source-search`)');
  }
  const limitValue = values.get('--limit');
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new CliUsageError(`--limit got '${limitValue ?? ''}', expected a whole number`);
  }
  const cursor = values.get('--cursor');
  const asOf = values.get('--as-of');
  const knewAt = values.get('--knew-at');
  const [, sourceId, partKind, ordinal] = PART_ADDRESS.exec(target) ?? [];
  const address =
    sourceId === undefined || partKind === undefined || ordinal === undefined
      ? { id: target }
      : { part: { sourceId, partKind, ordinal: Number(ordinal) } };
  return {
    ...address,
    json: flags.has('--json'),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(asOf === undefined ? {} : { asOf }),
    ...(knewAt === undefined ? {} : { knewAt }),
  };
}

export function runSourceCommand(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseSourceFlags,
    run: async (substrate, flags) => {
      const deps = sourceReadDeps({
        driver: substrate.connection().driver,
        db: substrate.db(),
        logger: substrate.logger(),
      });
      const outcome = await runSourceInspection(deps, {
        ...(flags.id === undefined ? {} : { id: flags.id }),
        ...(flags.part === undefined ? {} : { part: flags.part }),
        ...(flags.limit === undefined ? {} : { limit: flags.limit }),
        ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
        ...(flags.asOf === undefined ? {} : { asOf: flags.asOf }),
        ...(flags.knewAt === undefined ? {} : { knewAt: flags.knewAt }),
      });
      const output = sourceOutputFor(outcome);
      write(flags.json ? JSON.stringify(output) : sourceText(output));
      return output.status === 'source' ? 0 : 1;
    },
  });
}
