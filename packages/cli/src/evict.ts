import {
  armingPreconditions,
  EVICTION_COMPATIBILITY_REVISION,
  evictionArmingOperationId,
  evictionArmingPublication,
  PUBLICATION_KINDS,
  readCoverageState,
  readCurrentCoverageContract,
  type ArmingPrecondition,
  type SqliteHandle,
} from '@aion/core';

import { parseArgs, type ArgSpec } from './args.js';
import { lifecyclePublications } from './lifecycle.js';
import { confirmOrExit, stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion evict status | arm`: reading the destructive fence, and the one act that lowers it.
 *
 * Every substrate ships with eviction built and fenced. Nothing raises the fence on its own:
 * not `aion init`, not the service start, not the maintenance catalog. A person runs `arm`, and
 * until they have, `aion evict` removes nothing from anything.
 *
 * `arm` prints what it checked before it asks. The checks are not the whole reason the fence
 * exists, and saying which ones a machine can make is the honest way to hand the rest of the
 * judgment back to whoever is typing.
 */

const SPEC: ArgSpec<'status' | 'arm'> = {
  command: 'evict',
  usage: 'aion evict [status | arm] [--yes]',
  subcommands: ['status', 'arm'],
  options: [{ flag: '--yes' }],
};

export type EvictFlags = {
  readonly action: 'status' | 'arm';
  readonly yes: boolean;
};

export function parseEvictFlags(argv: readonly string[]): EvictFlags {
  const normalized = argv[0] === undefined || argv[0].startsWith('-') ? ['status', ...argv] : argv;
  const args = parseArgs(SPEC, normalized);
  return { action: args.subcommand, yes: args.flags.has('--yes') };
}

/** What the fence reads now, in the words `aion doctor` and `/health` use for the same row. */
export function writeGateState(db: SqliteHandle, write: Writer): void {
  const state = readCoverageState(db);
  write(
    state.evictionGate === 'armed'
      ? `eviction fence ARMED at compatibility revision ${String(state.evictionCompatibilityRevision)}`
      : 'eviction fence closed: no source is eligible and the operation removes nothing',
  );
  write(`coverage contract ${state.coverageState}, epoch ${state.coverageEpoch ?? 'unrecorded'}`);
}

export function writePreconditions(checks: readonly ArmingPrecondition[], write: Writer): boolean {
  for (const check of checks) {
    write(`  [${check.holds ? 'ok' : '--'}] ${check.name}: ${check.detail}`);
  }
  return checks.every((check) => check.holds);
}

async function arm(
  substrate: { readonly db: SqliteHandle },
  publish: () => Promise<{ readonly status: string; readonly reason?: string }>,
  flags: EvictFlags,
  write: Writer,
): Promise<number> {
  write('arming lets `episode_evict` remove archived Episode and Turn projections permanently.');
  // The whole table, not the first failure. Somebody deciding whether to arm wants the list.
  const ready = writePreconditions(
    armingPreconditions(substrate.db, PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION),
    write,
  );
  if (!ready) {
    stderrWriter('not armed: a precondition above does not hold');
    return 1;
  }
  if (!(await confirmOrExit('arm the eviction fence? [y/N] ', flags.yes, write))) {
    write('cancelled');
    return 1;
  }
  const outcome = await publish();
  if (outcome.status !== 'acknowledged') {
    stderrWriter(`not armed: ${outcome.reason ?? outcome.status}`);
    return 1;
  }
  write(`armed at compatibility revision ${String(EVICTION_COMPATIBILITY_REVISION)}`);
  return 0;
}

export function runEvict(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseEvictFlags,
    run: async (substrate, flags) => {
      const db = substrate.db();
      if (flags.action === 'status') {
        writeGateState(db, write);
        writePreconditions(
          armingPreconditions(db, PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION),
          write,
        );
        return 0;
      }
      // Bolt is needed only to arm: the coordinator takes the guard in the graph, and a status
      // read answers out of the records.
      const connection = await substrate.requireGraph('evict arm');
      if (connection === undefined) {
        return 1;
      }
      const epoch = readCurrentCoverageContract(db)?.epoch;
      if (epoch === undefined) {
        stderrWriter('not armed: no coverage registry to arm against');
        return 1;
      }
      const logger = substrate.logger();
      const publications = await lifecyclePublications({ connection, db, logger });
      return await arm(
        { db },
        async () =>
          await publications.publish({
            kind: evictionArmingPublication.kind,
            operationId: evictionArmingOperationId(EVICTION_COMPATIBILITY_REVISION, epoch),
            payload: { revision: EVICTION_COMPATIBILITY_REVISION, coverageEpoch: epoch },
          }),
        flags,
        write,
      );
    },
  });
}
