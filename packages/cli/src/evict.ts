import {
  ARMING_NOT_VERIFIED,
  armingPreconditions,
  disarmPreconditions,
  EVICTION_COMPATIBILITY_REVISION,
  evictionArmingOperationId,
  evictionArmingPublication,
  PUBLICATION_KINDS,
  readCoverageState,
  readCurrentCoverageContract,
  type ArmingPrecondition,
  type PublicationOutcome,
  type SqliteHandle,
} from '@aion/core';

import { parseArgs, type ArgSpec } from './args.js';
import { evictionFence } from './doctor-checks.js';
import { lifecyclePublications } from './lifecycle.js';
import { confirmOrExit, stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion evict status | arm | disarm`: reading the destructive fence, and the two acts that move it.
 *
 * Every substrate ships with eviction built and fenced. Nothing opens the fence on its own: not
 * `aion init`, not the service start, not the maintenance catalog. A person runs `arm`, and until
 * they have, `aion evict` removes nothing from anything.
 *
 * `disarm` is the way back, and it is not the inverse of arming. It stamps a stop that eviction
 * reads before it reads the revision, so the capability this substrate established stays on the
 * record. It stops future evictions and it cannot undo one that already happened.
 *
 * Both acts print what was checked AND what was not. A list of passing checks with nothing beside
 * it reads as full assurance, and the checks are the small half of what arming rests on.
 */

const SPEC: ArgSpec<'status' | 'arm' | 'disarm'> = {
  command: 'evict',
  usage: 'aion evict [status | arm | disarm] [--yes]',
  subcommands: ['status', 'arm', 'disarm'],
  options: [{ flag: '--yes' }],
};

export type EvictFlags = {
  readonly action: 'status' | 'arm' | 'disarm';
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
  write(evictionFence(state));
  write(`coverage contract ${state.coverageState}, epoch ${state.coverageEpoch ?? 'unrecorded'}`);
}

export function writePreconditions(checks: readonly ArmingPrecondition[], write: Writer): boolean {
  for (const check of checks) {
    write(`  [${check.holds ? 'ok' : '--'}] ${check.name}: ${check.detail}`);
  }
  return checks.every((check) => check.holds);
}

/**
 * The gaps, printed in the same breath as the checks.
 *
 * Six passing lines are six passing lines. What the fence exists for is a body of work no code can
 * inspect, and an operator who reads the table without this reads more assurance out of it than
 * anybody put in.
 */
export function writeNotVerified(write: Writer): void {
  write('not verified here, and nothing below can be:');
  for (const gap of ARMING_NOT_VERIFIED) {
    write(`  - ${gap}`);
  }
}

/** The one line the confirmation carries, so the gaps are the last thing read before the answer. */
export const ARM_CONFIRMATION =
  'arm the eviction fence? the checks above cover none of the unverified list [y/N] ';

type Act = 'arm' | 'disarm';

async function act(
  action: Act,
  db: SqliteHandle,
  publish: () => Promise<PublicationOutcome>,
  flags: EvictFlags,
  write: Writer,
): Promise<number> {
  if (action === 'arm') {
    write('arming lets `episode_evict` remove archived Episode and Turn projections permanently.');
  } else {
    write('disarming stops future evictions. It does not undo an eviction that already happened.');
  }
  // The whole table, not the first failure. Somebody deciding this wants the list.
  const ready = writePreconditions(
    action === 'arm'
      ? armingPreconditions(db, PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION)
      : disarmPreconditions(db),
    write,
  );
  if (action === 'arm') {
    writeNotVerified(write);
  }
  if (!ready) {
    stderrWriter(`not ${action}ed: a precondition above does not hold`);
    return 1;
  }
  const prompt = action === 'arm' ? ARM_CONFIRMATION : 'stop eviction on this substrate? [y/N] ';
  if (!(await confirmOrExit(prompt, flags.yes, write))) {
    write('cancelled');
    return 1;
  }
  const outcome = await publish();
  if (outcome.status !== 'acknowledged') {
    stderrWriter(`not ${action}ed: ${outcome.reason}`);
    return 1;
  }
  if (action === 'arm') {
    write(`armed at compatibility revision ${String(EVICTION_COMPATIBILITY_REVISION)}`);
    return 0;
  }
  write(`disarmed at ${outcome.knownFrom}; every source reads compatibility_disarmed from here`);
  write('an eviction already acknowledged stays done. Nothing puts a removed projection back.');
  write('an operation already holding the guard finishes under it; the next one is refused.');
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
        writeNotVerified(write);
        return 0;
      }
      // Bolt is needed only to move the fence: the coordinator takes the guard in the graph, and a
      // status read answers out of the records.
      const connection = await substrate.requireGraph(`evict ${flags.action}`);
      if (connection === undefined) {
        return 1;
      }
      const epoch = readCurrentCoverageContract(db)?.epoch;
      if (epoch === undefined) {
        stderrWriter(`not ${flags.action}ed: no coverage registry to act against`);
        return 1;
      }
      const logger = substrate.logger();
      const publications = await lifecyclePublications({ connection, db, logger });
      const now = new Date();
      return await act(
        flags.action,
        db,
        async () =>
          await publications.publish({
            kind: evictionArmingPublication.kind,
            operationId: evictionArmingOperationId(
              flags.action === 'arm' ? 'arm' : 'disarm',
              EVICTION_COMPATIBILITY_REVISION,
              epoch,
              now,
            ),
            payload: {
              act: flags.action,
              revision: EVICTION_COMPATIBILITY_REVISION,
              coverageEpoch: epoch,
              observedAt: now.toISOString(),
            },
          }),
        flags,
        write,
      );
    },
  });
}
