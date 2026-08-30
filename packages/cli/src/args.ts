/**
 * One argv walk for every command. Each command declares what it accepts and the walk reads
 * it, so a flag cannot be added to the parser and missed in the usage text, and an unknown
 * flag cannot pass silently the way `aion stats --help` once ran stats.
 */

/**
 * The one class every bad invocation raises. The diagnosis is the message and the runner
 * prints the command's usage line under it, so nothing depends on reading a class name back.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export type OptionSpec = {
  readonly flag: string;
  /** The one-letter spelling, where a command has one. */
  readonly alias?: string;
  /** Consumes the next argument as its value. */
  readonly takesValue?: boolean;
};

export type ArgSpec<S extends string = string> = {
  /** The command word every message names. */
  readonly command: string;
  /** The synopsis, with no `usage:` prefix, so it reads inside a message as well as alone. */
  readonly usage: string;
  /** When present, the first argument names one of these and the first entry is the default. */
  readonly subcommands?: readonly S[];
  readonly options?: readonly OptionSpec[];
  /** How many bare arguments the command takes. Anything past this is a usage error. */
  readonly maxPositionals?: number;
  /** What an unknown-option message lists, when that is not just the option flags. */
  readonly supported?: readonly string[];
};

export type ParsedArgs<S extends string = string> = {
  /** The empty string for a command with no subcommands. */
  readonly subcommand: S;
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
};

/** Every command answers these before it opens anything, so help works on a broken substrate. */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export function unknownOption(spec: ArgSpec, arg: string): CliUsageError {
  const supported = spec.supported ?? (spec.options ?? []).map((option) => option.flag);
  const suffix = supported.length === 0 ? '' : ` (supported: ${supported.join(', ')})`;
  return new CliUsageError(`unknown option '${arg}' for ${spec.command}${suffix}`);
}

/**
 * A command that takes no bare arguments reads a stray word as a mistyped option, which is
 * what it almost always is. One that does take them names the argument it could not place.
 */
function rejected(spec: ArgSpec, arg: string, maxPositionals: number): CliUsageError {
  if (arg.startsWith('-') || maxPositionals === 0) {
    return unknownOption(spec, arg);
  }
  return new CliUsageError(
    `unexpected extra argument '${arg}' for ${spec.command} (usage: ${spec.usage})`,
  );
}

function isSubcommand<S extends string>(subcommands: readonly S[], value: string): value is S {
  return (subcommands as readonly string[]).includes(value);
}

function readSubcommand<S extends string>(
  spec: ArgSpec<S>,
  argv: readonly string[],
): { readonly subcommand: S; readonly rest: readonly string[] } {
  const subcommands = spec.subcommands ?? [];
  const fallback = subcommands[0];
  if (fallback === undefined) {
    return { subcommand: '' as S, rest: argv };
  }
  const [first = fallback, ...rest] = argv;
  if (!isSubcommand(subcommands, first)) {
    throw new CliUsageError(
      `unknown ${spec.command} subcommand '${first}' (supported: ${subcommands.join(', ')})`,
    );
  }
  return { subcommand: first, rest };
}

export function parseArgs<S extends string>(
  spec: ArgSpec<S>,
  argv: readonly string[],
): ParsedArgs<S> {
  const { subcommand, rest } = readSubcommand(spec, argv);
  const options = spec.options ?? [];
  const maxPositionals = spec.maxPositionals ?? 0;
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? '';
    const option = options.find((entry) => entry.flag === arg || entry.alias === arg);
    if (option === undefined) {
      if (arg.startsWith('-') || positionals.length >= maxPositionals) {
        throw rejected(spec, arg, maxPositionals);
      }
      positionals.push(arg);
      continue;
    }
    if (option.takesValue !== true) {
      flags.add(option.flag);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) {
      throw new CliUsageError(`${option.flag} needs a value`);
    }
    values.set(option.flag, value);
    index += 1;
  }

  return { subcommand, flags, values, positionals };
}
