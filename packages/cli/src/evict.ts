import {
  ARMING_NOT_VERIFIED,
  armingPreconditions,
  disarmPreconditions,
  EVICTION_COMPATIBILITY_REVISION,
  evictionArmingOperationId,
  evictionArmingPublication,
  INSTALLED_PUBLICATION_KINDS,
  readCoverageState,
  readCurrentCoverageContract,
  rearmPreconditions,
  type ArmingPrecondition,
  type CoverageStateReport,
  type PublicationOutcome,
  type SqliteHandle,
} from '@aion/core';

import { parseArgs, type ArgSpec } from './args.js';
import { evictionFence } from './doctor-checks.js';
import { lifecyclePublications } from './lifecycle.js';
import { confirmOrExit, stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

/**
 * `aion evict status | disarm | rearm`: reading the destructive fence, and the two acts an
 * operator takes on it.
 *
 * The first arming is not here any more. The service arms the fence at start, through the same
 * audited operation and against the same precondition table (`armEvictionOnStart`); the manual
 * step was removed on 2026-09-12. What the checks cannot verify has not changed and has not gone
 * away: it is printed on `status`, and again by `rearm`, which is the one decision left that opens
 * the capability.
 *
 * `disarm` stays, because stopping is the operator's. It is not the inverse of arming: it stamps a
 * stop that eviction reads before it reads the revision, so the capability this substrate
 * established stays on the record. It stops future evictions, it cannot undo one that already
 * happened, and a restart does not lift it.
 *
 * It also stops one that is halfway. The guard settles whatever is already pending before it takes
 * a new request, so a stop that only became durable at its own acknowledgment would be recorded on
 * a substrate the removal had already left. The claim goes down before anything is settled, and
 * the pending attempt meets it at its own recovery re-check.
 *
 * `rearm` is the way back, and it exists because a stop must not be a one-way door. It is the one
 * act allowed to lift a stop that was asked for and never recorded: the service start refuses that
 * case on purpose, and a person naming it out loud is when clearing it is right. The prompt says
 * which stop it lifts and when the substrate recorded it.
 */

const SPEC: ArgSpec<'status' | 'disarm' | 'rearm'> = {
  command: 'evict',
  usage: 'aion evict [status | disarm | rearm] [--yes]',
  subcommands: ['status', 'disarm', 'rearm'],
  options: [{ flag: '--yes' }],
};

export type EvictFlags = {
  readonly action: 'status' | 'disarm' | 'rearm';
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
 * Seven passing lines are seven passing lines. What the fence exists for is a body of work no code
 * can inspect, and a reader who sees the table without this reads more assurance out of it than
 * anybody put in. This is why the list did not move when the arming step did: the fence arms
 * itself now, so `status` is the surface that has to carry both halves.
 */
export function writeNotVerified(write: Writer): void {
  write('not verified here, and nothing below can be:');
  for (const gap of ARMING_NOT_VERIFIED) {
    write(`  - ${gap}`);
  }
}

/**
 * The stop, from the announcement to the answer.
 *
 * The confirmation is a parameter rather than a call so the question this prints is the question
 * that gets asked. A prompt assembled here and answered somewhere else can drift apart, and the
 * whole point of the wording is that it is what the operator agrees to.
 */
export async function runEvictDisarm(
  db: SqliteHandle,
  publish: () => Promise<PublicationOutcome>,
  confirm: (prompt: string) => Promise<boolean>,
  write: Writer,
): Promise<number> {
  write('disarming stops future evictions. It does not undo an eviction that already happened.');
  write('It also holds through a restart: the service does not re-arm a substrate you stopped.');
  // The whole table, not the first failure. Somebody deciding this wants the list.
  const ready = writePreconditions(disarmPreconditions(db), write);
  if (!ready) {
    stderrWriter('not disarmed: a precondition above does not hold');
    return 1;
  }
  if (!(await confirm('stop eviction on this substrate? [y/N] '))) {
    write('cancelled');
    return 1;
  }
  const outcome = await publish();
  if (outcome.status !== 'acknowledged') {
    stderrWriter(`not disarmed: ${outcome.reason}`);
    return 1;
  }
  write(`disarmed at ${outcome.knownFrom}; every source reads compatibility_disarmed from here`);
  write('an eviction already acknowledged stays done. Nothing puts a removed projection back.');
  write(
    'an attempt that had not written yet is refused, including one this command found pending.',
  );
  write(
    'an attempt whose graph write already committed finishes: the removal happened either way.',
  );
  return 0;
}

/**
 * What a re-arm would lift, read before anything is published. `undefined` means there is nothing
 * to take back, which is the no-op the command reports rather than a refusal: somebody who ran it
 * on an armed substrate got the state they wanted.
 */
export function standingStop(state: CoverageStateReport): string | undefined {
  if (state.evictionDisarmedAt !== null) {
    return `the stop recorded at ${state.evictionDisarmedAt}`;
  }
  if (state.evictionStopRequestedBy !== null) {
    return `the stop owed by ${state.evictionStopRequestedBy}, which was never recorded`;
  }
  return undefined;
}

/**
 * Taking a stop back.
 *
 * It prints what it is about to lift and when the substrate recorded it, then the same gaps an
 * arming decision has always carried, because this is now the only decision that opens the
 * capability. The act goes through the coordinator like any other, so the lift leaves a receipt
 * beside the stop it reverses, and the two read in sequence.
 */
export async function runEvictRearm(
  db: SqliteHandle,
  publish: () => Promise<PublicationOutcome>,
  confirm: (prompt: string) => Promise<boolean>,
  write: Writer,
): Promise<number> {
  const state = readCoverageState(db);
  const lifting = standingStop(state);
  if (lifting === undefined) {
    write(evictionFence(state));
    write('nothing to lift: no stop stands on this substrate, so there is nothing to take back.');
    write('The service arms the fence at start; `aion evict status` is where it reports why not.');
    return 0;
  }
  write(`rearming lifts ${lifting}.`);
  write('Eviction removes archived Episode and Turn projections permanently from there.');
  const ready = writePreconditions(
    rearmPreconditions(db, INSTALLED_PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION),
    write,
  );
  writeNotVerified(write);
  if (!ready) {
    stderrWriter('not rearmed: a precondition above does not hold');
    return 1;
  }
  if (
    !(await confirm(`lift ${lifting}? the checks above cover none of the unverified list [y/N] `))
  ) {
    write('cancelled');
    return 1;
  }
  const outcome = await publish();
  if (outcome.status !== 'acknowledged') {
    stderrWriter(`not rearmed: ${outcome.reason}`);
    return 1;
  }
  write(`armed at compatibility revision ${String(EVICTION_COMPATIBILITY_REVISION)}`);
  write('the stop is lifted and a restart keeps it armed. `aion evict disarm` stops it again.');
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
        // The table the service's own arm is checked against, so what it refused on is readable
        // here rather than only in the boot log. A failing line is retried at the next start.
        writePreconditions(
          armingPreconditions(db, INSTALLED_PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION),
          write,
        );
        writeNotVerified(write);
        return 0;
      }
      // Bolt is needed only to move the fence: the coordinator takes the guard in the graph, and a
      // status read answers out of the records.
      const { action } = flags;
      const connection = await substrate.requireGraph(`evict ${action}`);
      if (connection === undefined) {
        return 1;
      }
      const epoch = readCurrentCoverageContract(db)?.epoch;
      if (epoch === undefined) {
        stderrWriter(`not ${action}ed: no coverage registry to act against`);
        return 1;
      }
      const logger = substrate.logger();
      const publications = await lifecyclePublications({ connection, db, logger });
      const now = new Date();
      // Its own moment in its own identity: a stop and the lift of it are two decisions on one
      // substrate under one revision and one contract, and each takes its own receipt.
      const publish = async (): Promise<PublicationOutcome> =>
        await publications.publish({
          kind: evictionArmingPublication.kind,
          operationId: evictionArmingOperationId(
            action,
            EVICTION_COMPATIBILITY_REVISION,
            epoch,
            now,
          ),
          payload: {
            act: action,
            revision: EVICTION_COMPATIBILITY_REVISION,
            coverageEpoch: epoch,
            observedAt: now.toISOString(),
          },
        });
      const confirm = async (prompt: string): Promise<boolean> =>
        await confirmOrExit(prompt, flags.yes, write);
      if (action === 'rearm') {
        return await runEvictRearm(db, publish, confirm, write);
      }
      return await runEvictDisarm(db, publish, confirm, write);
    },
  });
}
