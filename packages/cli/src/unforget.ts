import {
  previewSupersession,
  type GraphConnection,
  type Logger,
  type SqliteHandle,
} from '@aion/core';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { preview } from './format.js';
import { confirmOrExit, stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';
import { publishSuppression, reportSuppression } from './suppression.js';

/**
 * `aion unforget <node_id>`: taking back a forget, and the other half of the statement chain.
 *
 * A forget was permanent because nothing wrote the reversal, not because the records could not
 * hold one: `source_state_versions` has admitted an `unforgotten` kind since the chain existed.
 * The chain is what answers, so the forget stays on the record and the reversal sits after it —
 * a `knew_at` read from before this still sees the node as forgotten, which is the point.
 *
 * It is not `aion unsupersede`. That reopens a close something else made and leaves a forget
 * standing; this drops the suppression stamp and leaves a supersession standing. Two
 * suppressions, one act each, and one undo each.
 */

const SPEC: ArgSpec = {
  command: 'unforget',
  usage: 'aion unforget <node_id> [--yes]',
  options: [{ flag: '--yes' }],
  maxPositionals: 1,
};

export type UnforgetFlags = {
  readonly nodeId: string;
  readonly yes: boolean;
};

export function parseUnforgetFlags(argv: readonly string[]): UnforgetFlags {
  const { flags, positionals } = parseArgs(SPEC, argv);
  const [nodeId] = positionals;
  if (nodeId === undefined || nodeId.trim().length === 0) {
    throw new CliUsageError(
      'unforget needs a node id: `aion unforget <node_id>` (see `aion why <id>`)',
    );
  }
  return { nodeId, yes: flags.has('--yes') };
}

type UnforgetDeps = {
  readonly connection: GraphConnection;
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export function runUnforget(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseUnforgetFlags,
    needsGraph: 'unforget',
    run: async (substrate, flags) => {
      const deps: UnforgetDeps = {
        connection: substrate.connection(),
        db: substrate.db(),
        logger: substrate.logger(),
      };
      // The same reader `aion unsupersede` previews with, because it is the one read that
      // answers about both suppressions at once and this command has to say which it undoes.
      const node = await previewSupersession(deps.connection.driver, flags.nodeId);
      if (node === undefined) {
        stderrWriter(`no node found for '${flags.nodeId}'`);
        return 1;
      }
      if (!node.forgotten) {
        write(`${node.id} is not forgotten; nothing to undo`);
        return 0;
      }

      write(`about to unforget ${node.id} (${node.labels.join(', ')}): ${preview(node.content)}`);
      if (node.closed) {
        write('  this node is also superseded; unforgetting does not reopen that');
      }
      if (!(await confirmOrExit('unforget it? [y/N] ', flags.yes, write))) {
        write('cancelled');
        return 1;
      }

      const report = await publishSuppression(deps, 'unforget', flags.nodeId, new Date());
      return reportSuppression('unforget', flags.nodeId, report, deps.logger, write);
    },
  });
}
