import type { Config, GraphConnection, SqliteHandle } from '@aion/core';

import { parseArgs, type ArgSpec } from './args.js';
import { stdoutWriter, type Writer } from './output.js';
import { collectSnapshot, renderSnapshot, type Snapshot } from './snapshot.js';
import { withSubstrate } from './substrate.js';

const SPEC: ArgSpec = {
  command: 'status',
  usage: 'aion status',
};

/** The base view: everything both `status` and `stats` read from the substrate. */
export type StatusSnapshot = Snapshot;

export function collectStatus(
  config: Config,
  connection: GraphConnection,
  db: SqliteHandle,
): Promise<StatusSnapshot> {
  return collectSnapshot(config, connection, db, { extras: false });
}

export function renderStatus(snapshot: StatusSnapshot, config: Config, write: Writer): void {
  renderSnapshot(snapshot, config, write);
}

export function runStatus(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: (args) => parseArgs(SPEC, args),
    run: async (substrate) => {
      const { config } = substrate;
      const snapshot = await collectStatus(config, substrate.connection(), substrate.db());
      renderStatus(snapshot, config, write);
      substrate.logger().info({ snapshot }, 'status reported');
      return snapshot.neo4j.reachable && snapshot.ollama.reachable ? 0 : 1;
    },
  });
}
