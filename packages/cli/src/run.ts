import { runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { runStatus } from './status.js';

export const CLI_NAME = 'aion';

type Command = {
  summary: string;
  run: (argv: readonly string[]) => Promise<number>;
};

const commands: Record<string, Command> = {
  init: {
    summary: 'provision the substrate: neo4j, models, schema, backbone',
    run: (argv) => runInit(argv),
  },
  status: {
    summary: 'services, models, and graph counts',
    run: (argv) => runStatus(argv),
  },
  doctor: {
    summary: 'check every substrate invariant and name what is broken',
    run: (argv) => runDoctor(argv),
  },
  help: {
    summary: 'show this message',
    run: async () => {
      process.stdout.write(usage());
      return 0;
    },
  },
};

function usage(): string {
  const names = Object.keys(commands);
  const width = Math.max(...names.map((name) => name.length));
  const rows = names.map((name) => {
    return `  ${name.padEnd(width)}  ${commands[name]?.summary ?? ''}`;
  });
  return [
    `${CLI_NAME} — local memory substrate`,
    '',
    `usage: ${CLI_NAME} <command> [options]`,
    '',
    'commands:',
    ...rows,
    '',
  ].join('\n');
}

/**
 * Dispatch only. Each command opens its own logger from validated config, which is what
 * keeps the config module the one reader of AION_* vars: a second env read here would
 * take a bad log level silently and miss the unknown-variable check entirely.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const [first = 'help', ...rest] = argv;
  const name = first === '--help' || first === '-h' ? 'help' : first;

  const command = commands[name];
  if (command === undefined) {
    process.stderr.write(`${CLI_NAME}: unknown command '${name}'\n\n${usage()}`);
    return 1;
  }
  return command.run(rest);
}
