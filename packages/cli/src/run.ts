import { runDoctor } from './doctor.js';
import { runForget } from './forget.js';
import { runHooks } from './hooks-cmd.js';
import { runInit } from './init.js';
import { runLast } from './last.js';
import { runMaintain } from './maintain.js';
import { runProposals } from './proposals.js';
import { runQueue } from './queue.js';
import { runSearch } from './search.js';
import { runStats } from './stats.js';
import { runStatus } from './status.js';
import { runUnmerge } from './unmerge.js';
import { runWhy } from './why.js';

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
  hooks: {
    summary: 'install the Claude Code harness hooks: install | uninstall | status',
    run: (argv) => runHooks(argv),
  },
  status: {
    summary: 'services, models, routing, and graph counts',
    run: (argv) => runStatus(argv),
  },
  doctor: {
    summary: 'check every substrate invariant and name what is broken',
    run: (argv) => runDoctor(argv),
  },
  last: {
    summary: 'the last MemoryPack served per session, with rationale',
    run: (argv) => runLast(argv),
  },
  queue: {
    summary: 'inspect the reflection queue: ls | drop | promote | reconcile',
    run: (argv) => runQueue(argv),
  },
  proposals: {
    summary: 'review judged contradictions and duplicate entities: ls | apply | dismiss',
    run: (argv) => runProposals(argv),
  },
  maintain: {
    summary: 'the maintenance catalog, and forcing one operation to run now: ls | run',
    run: (argv) => runMaintain(argv),
  },
  unmerge: {
    summary: 'split an identity back out of the entity dedup absorbed it into: ls | apply',
    run: (argv) => runUnmerge(argv),
  },
  stats: {
    summary: 'substrate counts, queue and plasticity health, cadence, per-method pack shares',
    run: (argv) => runStats(argv),
  },
  why: {
    summary: 'provenance, lineage, and open proposals for one node',
    run: (argv) => runWhy(argv),
  },
  search: {
    summary: 'direct hybrid search through the seed layer, bypassing pack assembly',
    run: (argv) => runSearch(argv),
  },
  forget: {
    summary: 'bitemporal close of a node by id or query: nothing is deleted',
    run: (argv) => runForget(argv),
  },
  help: {
    summary: 'show this message',
    run: () => {
      process.stdout.write(usage());
      return Promise.resolve(0);
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
    `${CLI_NAME}... local memory substrate`,
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
