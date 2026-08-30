import {
  previewSupersession,
  unsupersedeNode,
  type GraphConnection,
  type Logger,
  type SupersessionPreview,
} from '@aion/core';
import { createInterface } from 'node:readline/promises';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { preview } from './format.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion unsupersede <node_id>`: the undo for a close, whatever made it.
 *
 * A correction the substrate got wrong is otherwise permanent. `aion forget` suppresses the
 * replacement and leaves the closed claim closed, and dismissing the proposal after the fact
 * changes nothing, so before this there was no way to say "that claim still stands". It matters
 * more the more the pipeline closes on its own: under `AION_SUPERSEDE_MODE=unanimous` the two
 * passes agree without anyone watching, and an autonomous close a person cannot reverse is a
 * substrate that argues with its owner.
 *
 * Nothing is deleted. The lineage edge is closed in system time and the node gets its currency
 * back, so `aion why` shows the supersession and the reopen both.
 */

const SPEC: ArgSpec = {
  command: 'unsupersede',
  usage: 'aion unsupersede <node_id> [--yes]',
  options: [{ flag: '--yes' }],
  maxPositionals: 1,
};

export type UnsupersedeFlags = {
  readonly nodeId: string;
  readonly yes: boolean;
};

export function parseUnsupersedeFlags(argv: readonly string[]): UnsupersedeFlags {
  const { flags, positionals } = parseArgs(SPEC, argv);
  const [nodeId] = positionals;
  if (nodeId === undefined || nodeId.trim().length === 0) {
    throw new CliUsageError(
      'unsupersede needs a node id: `aion unsupersede <node_id>` (see `aion why <id>`)',
    );
  }
  return { nodeId, yes: flags.has('--yes') };
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** `--yes` skips the ask; with no terminal to ask on, `--yes` is the only way through. */
async function confirm(assumeYes: boolean, write: Writer): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    write('re-run with --yes to reopen it (no terminal to confirm on)');
    return false;
  }
  const answer = (await askOnTerminal('reopen it? [y/N] ')).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export function renderPreview(node: SupersessionPreview, write: Writer): void {
  write(`about to reopen ${node.id} (${node.labels.join(', ')}): ${preview(node.content)}`);
  for (const lineage of node.lineage) {
    const method = lineage.provenance.length === 0 ? 'unrecorded' : lineage.provenance.join(', ');
    write(`  superseded by ${lineage.supersededBy}, closed by ${method}`);
  }
  if (node.forgotten) {
    // Two suppressions, one act each. Reopening the supersession leaves the forget standing,
    // and saying so here stops an operator expecting the node back in default recall.
    write('  this node is also forgotten; reopening the supersession does not undo that');
  }
}

export function runUnsupersede(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseUnsupersedeFlags,
    needsGraph: 'unsupersede',
    run: async (substrate, flags) => {
      const connection: GraphConnection = substrate.connection();
      const logger: Logger = substrate.logger();
      const node = await previewSupersession(connection.driver, flags.nodeId);
      if (node === undefined) {
        stderrWriter(`no node found for '${flags.nodeId}'`);
        return 1;
      }
      if (!node.closed && node.lineage.length === 0) {
        write(`${node.id} is already current; nothing to reopen`);
        return 0;
      }

      renderPreview(node, write);
      if (!(await confirm(flags.yes, write))) {
        write('cancelled');
        return 1;
      }

      const result = await unsupersedeNode(connection.driver, { id: flags.nodeId });
      logger.warn(
        {
          nodeId: result.id,
          reopenedAt: result.reopenedAt.toISOString(),
          reopenedFrom: result.reopenedFrom.map((lineage) => lineage.supersededBy),
        },
        'node reopened',
      );
      write(
        `reopened ${result.id} at ${result.reopenedAt.toISOString()}: ` +
          `${String(result.reopenedFrom.length)} supersession(s) closed`,
      );
      write('the lineage is kept and stamped; `aion why` shows the close and the reopen both');
      return 0;
    },
  });
}
