import { runConsolidate } from './consolidate.js';
import { runCosts } from './costs.js';
import { runDoctor } from './doctor.js';
import { runEvict } from './evict.js';
import { runForget } from './forget.js';
import { runHooks } from './hooks-cmd.js';
import { runInit } from './init.js';
import { runLast } from './last.js';
import { runLogs } from './logs.js';
import { runMaintain } from './maintain.js';
import { runProposals } from './proposals.js';
import { runQueue } from './queue.js';
import { runReplayCommand } from './replay.js';
import { runSearch } from './search.js';
import { runSourceSearchCommand } from './source-search.js';
import { runSourceCommand } from './source.js';
import { runStats } from './stats.js';
import { runStatus } from './status.js';
import { runTimelineCommand } from './timeline.js';
import { runUnforget } from './unforget.js';
import { runUninstall } from './uninstall.js';
import { runUnmerge } from './unmerge.js';
import { runUnsupersede } from './unsupersede.js';
import { runWhy } from './why.js';

export const CLI_NAME = 'aion';

type Command = {
  summary: string;
  run: (argv: readonly string[]) => Promise<number>;
};

const commands: Record<string, Command> = {
  consolidate: {
    summary: 'resume or inspect a fixed narrative migration: status | run',
    run: (argv) => runConsolidate(argv),
  },
  costs: {
    summary: 'API token usage and estimated cost by day and surface',
    run: (argv) => runCosts(argv),
  },
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
  logs: {
    summary: 'tail the substrate log file: -n <lines> | --level <level> | -f',
    run: (argv) => runLogs(argv),
  },
  uninstall: {
    summary: 'remove what init put on this machine, and say what it left',
    run: (argv) => runUninstall(argv),
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
    summary: 'inspect the reflection queue: ls | drop | promote | reconcile | index',
    run: (argv) => runQueue(argv),
  },
  replay: {
    summary: 'put archived experiences and the usage stream back: ls | run | usage',
    run: (argv) => runReplayCommand(argv),
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
  timeline: {
    summary: 'one episode across the archive, the graph, the queue, and the ledger',
    run: (argv) => runTimelineCommand(argv),
  },
  search: {
    summary: 'direct hybrid search through the seed layer, bypassing pack assembly',
    run: (argv) => runSearch(argv),
  },
  'source-search': {
    summary: 'literal text against the captured archive, with what the index could not cover',
    run: (argv) => runSourceSearchCommand(argv),
  },
  source: {
    summary: 'the captured parts behind one source id, turn id, or part address',
    run: (argv) => runSourceCommand(argv),
  },
  forget: {
    summary: 'bitemporal close of a node by id or query: nothing is deleted',
    run: (argv) => runForget(argv),
  },
  evict: {
    summary: 'the destructive fence and the two acts that move it: status | disarm | rearm',
    run: (argv) => runEvict(argv),
  },
  unforget: {
    summary: 'take back a forget: the statement chain keeps both, the node serves again',
    run: (argv) => runUnforget(argv),
  },
  unsupersede: {
    summary: 'reopen a claim a supersession closed, whatever made the close',
    run: (argv) => runUnsupersede(argv),
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
