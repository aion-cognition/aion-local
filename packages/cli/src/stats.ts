import type { Config, GraphConnection, SqliteHandle } from '@aion/core';

import { parseArgs, type ArgSpec } from './args.js';
import { stdoutWriter, type Writer } from './output.js';
import { collectSnapshot, renderSnapshot, type Snapshot, type SnapshotExtras } from './snapshot.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion stats`: the same substrate reading `aion status` renders, with the verbose extras
 * appended. Cadence answers whether the agent is actually calling recall; the per-method
 * shares are the spirit metric, permanent so the associative-mechanisms claim stays a
 * measurement, not an argument.
 */

const SPEC: ArgSpec = {
  command: 'stats',
  usage: 'aion stats',
};

export type StatsSnapshot = Snapshot & { readonly extras: SnapshotExtras };

export function collectStats(
  config: Config,
  connection: GraphConnection,
  db: SqliteHandle,
): Promise<StatsSnapshot> {
  return collectSnapshot(config, connection, db, { extras: true });
}

export function renderStats(
  snapshot: StatsSnapshot,
  config: Config,
  write: Writer,
  now: number = Date.now(),
): void {
  renderSnapshot(snapshot, config, write, now);
}

export function runStats(
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
      const snapshot = await collectStats(config, substrate.connection(), substrate.db());
      renderStats(snapshot, config, write);
      substrate.logger().info(
        {
          ...snapshot,
          extras: {
            ...snapshot.extras,
            labelCounts: Object.fromEntries(snapshot.extras.labelCounts),
          },
        },
        'stats reported',
      );
      return snapshot.neo4j.reachable ? 0 : 1;
    },
  });
}
