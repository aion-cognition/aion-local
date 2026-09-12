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
 * `aion evict status | disarm`: reading the destructive fence, and the one act an operator takes
 * on it.
 *
 * Arming is not here any more. The service arms the fence at start, through the same audited
 * operation and against the same precondition table (`armEvictionOnStart`); the manual step was
 * removed on 2026-09-12. What the checks cannot verify has not changed and has not gone away:
 * `status` prints the table and the unverified list together, which is now the only place either
 * is printed.
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
 */

const SPEC: ArgSpec<'status' | 'disarm'> = {
  command: 'evict',
  usage: 'aion evict [status | disarm] [--yes]',
  subcommands: ['status', 'disarm'],
  options: [{ flag: '--yes' }],
};

export type EvictFlags = {
  readonly action: 'status' | 'disarm';
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
      const connection = await substrate.requireGraph('evict disarm');
      if (connection === undefined) {
        return 1;
      }
      const epoch = readCurrentCoverageContract(db)?.epoch;
      if (epoch === undefined) {
        stderrWriter('not disarmed: no coverage registry to act against');
        return 1;
      }
      const logger = substrate.logger();
      const publications = await lifecyclePublications({ connection, db, logger });
      const now = new Date();
      return await runEvictDisarm(
        db,
        async () =>
          await publications.publish({
            kind: evictionArmingPublication.kind,
            operationId: evictionArmingOperationId(
              'disarm',
              EVICTION_COMPATIBILITY_REVISION,
              epoch,
              now,
            ),
            payload: {
              act: 'disarm',
              revision: EVICTION_COMPATIBILITY_REVISION,
              coverageEpoch: epoch,
              observedAt: now.toISOString(),
            },
          }),
        async (prompt) => await confirmOrExit(prompt, flags.yes, write),
        write,
      );
    },
  });
}
