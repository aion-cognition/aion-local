import {
  listUnmergeableRecords,
  runEntityUnmerge,
  type GraphConnection,
  type UnmergedDecision,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { short } from './format.js';
import { stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

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
 * `apply <merged-id>` splits one of those identities back out, and says what the merge thought
 * it knew, so the reversal names the evidence that was wrong rather than only the node.
 */

/** One line naming the tier that merged and the reasons it recorded. */
export function describeUnmergedDecision(decision: UnmergedDecision): string {
  const reasons =
    decision.reasons.length === 0 ? 'no reason recorded' : decision.reasons.join('; ');
  return `merged by ${decision.tier}: ${reasons}`;
}

const SUBCOMMANDS = ['ls', 'apply'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const SPEC: ArgSpec<Subcommand> = {
  command: 'unmerge',
  usage: 'aion unmerge [ls|apply] <id>',
  subcommands: SUBCOMMANDS,
  maxPositionals: 1,
};

export type UnmergeFlags = {
  readonly subcommand: Subcommand;
  readonly id: string;
};

export function parseUnmergeFlags(argv: readonly string[]): UnmergeFlags {
  const { subcommand, positionals } = parseArgs(SPEC, argv);
  const [id] = positionals;
  if (id === undefined) {
    const needs = subcommand === 'ls' ? 'a canonical entity id' : 'the absorbed entity id';
    throw new CliUsageError(`unmerge ${subcommand} needs ${needs}`);
  }
  return { subcommand, id };
}

async function runLs(connection: GraphConnection, id: string, write: Writer): Promise<number> {
  const records = await listUnmergeableRecords(connection.driver, id);
  if (records.length === 0) {
    // Two states with one answer: the id names no entity, or it names one that has absorbed
    // nothing. Neither has anything to split, and telling them apart would take a second read
    // for an answer that is the same either way.
    write(`${id} has no merge record with an identity left to split out`);
    return 0;
  }
  write(`${id} has absorbed ${String(records.length)} identity(ies)`);
  for (const record of records) {
    write(
      `  ${record.mergedId}  ${record.mergedName ?? 'name not recorded'}` +
        ` (${record.mergedType ?? 'type not recorded'}), ` +
        `${String(record.edges.length)} edge(s) recorded`,
    );
  }
  write('');
  write('`aion unmerge apply <id>` splits one of them back out');
  return 0;
}

export function runUnmerge(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseUnmergeFlags,
    needsGraph: 'unmerge',
    run: async (substrate, flags) => {
      const connection = substrate.connection();
      if (flags.subcommand === 'ls') {
        return await runLs(connection, flags.id, write);
      }

      const report = await runEntityUnmerge(
        { driver: connection.driver, db: substrate.db(), logger: substrate.logger() },
        { mergedId: flags.id },
      );
      write(`${flags.id}: ${report.status}, ${report.detail}`);
      if (report.restoredId !== undefined) {
        write(`  restored as ${report.restoredId} out of ${short(report.canonicalId ?? '')}`);
        write(`  ${String(report.aliasesReleased)} alias(es) released`);
      }
      if (report.decision !== undefined) {
        write(`  ${describeUnmergedDecision(report.decision)}`);
        write(`  decision record ${short(report.decision.id)}`);
      }
      return 0;
    },
  });
}
