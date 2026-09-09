import { afterAll, beforeAll, expect, it } from 'vitest';

import { runRead } from './connection.js';
import {
  errorChain,
  mentionsDeadlock,
  runClientFlow,
  startIntakeProbe,
  stopIntakeProbe,
  type IntakeProbe,
} from './test-support/session-intake.fixture.js';

/**
 * The shipped client flow run against itself: connect, then store, two clients at once, with
 * the one-at-a-time arm beside it as the control. Both arms drive
 * `ensureSession -> intakePublication`, which is the pair whose Session-node lock order was
 * inverted, and both are expected to come back clean.
 *
 * A clean repeat count is not on its own a proof of order; the order itself is settled in
 * `session-chain-lock-order.int.test.ts`. This file is the workload arm: it says the corrected
 * order holds while two whole flows overlap, and the control says the failures it would have
 * counted are not simply absent from a serial run.
 *
 * Rates measured here describe this workload on the machine that ran it.
 */

const SEQUENTIAL_ATTEMPTS = Number(process.env.AION_INTAKE_SEQUENTIAL_ATTEMPTS ?? '20');
const CONCURRENT_ATTEMPTS = Number(process.env.AION_INTAKE_CONCURRENT_ATTEMPTS ?? '20');
const CONCURRENT_CREATIONS = 8;

let probe: IntakeProbe;

beforeAll(async () => {
  probe = await startIntakeProbe({ prefix: 'aion-intake-concurrency-' });
}, 300_000);

afterAll(async () => {
  await stopIntakeProbe(probe);
});

type Failure = { readonly attempt: number; readonly deadlock: boolean; readonly chain: string };

function failureOf(attempt: number, reason: unknown): Failure {
  return { attempt, deadlock: mentionsDeadlock(reason), chain: errorChain(reason) };
}

it('control: one client at a time never fails', async () => {
  const failures: Failure[] = [];
  for (let attempt = 0; attempt < SEQUENTIAL_ATTEMPTS; attempt += 1) {
    const occurredAt = new Date();
    const marker = `seq-${String(attempt)}`;
    try {
      await runClientFlow(probe, { identity: marker, marker, occurredAt });
    } catch (err) {
      failures.push(failureOf(attempt, err));
    }
  }

  expect(failures).toEqual([]);
}, 900_000);

it('two whole client flows at once, as the service runs them', async () => {
  const failures: Failure[] = [];
  for (let attempt = 0; attempt < CONCURRENT_ATTEMPTS; attempt += 1) {
    const occurredAt = new Date();
    const marker = `pair-${String(attempt)}`;
    const settled = await Promise.allSettled(
      ['a', 'b'].map((side) =>
        runClientFlow(probe, {
          identity: `${marker}-${side}`,
          marker: `${marker}-${side}`,
          occurredAt,
        }),
      ),
    );
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        failures.push(failureOf(attempt, outcome.reason));
      }
    }
  }

  expect(failures.filter((failure) => failure.deadlock)).toEqual([]);
  expect(failures).toEqual([]);
  expect(probe.coordinator.hasPending()).toBe(false);
}, 900_000);

/**
 * The chain the member's sessions form, over every session this file created: the sequential
 * arm, both sides of every concurrent pair, and one last burst created in one go. A fork shows
 * up as a session two others follow, a cycle as a session reachable from itself, and a lost
 * update as a second session nothing follows.
 */
it('leaves one unforked, acyclic chain under concurrent session creation', async () => {
  const now = new Date();
  await Promise.all(
    Array.from({ length: CONCURRENT_CREATIONS }, (_unused, index) =>
      probe.sessions.ensureSession({ identity: `burst-${String(index)}`, now, occurredAt: now }),
    ),
  );

  const links = await runRead(
    probe.substrate.harness.driver,
    [
      'MATCH (s:Session)-[:INITIATED_BY]->(:Member { id: $memberId })',
      'MATCH (s)-[:WITHIN_WORKSPACE]->(:Workspace { id: $workspaceId })',
      'RETURN s.id AS id,',
      '       size([(s)-[:FOLLOWS]->() | 1]) AS outgoing,',
      '       size([(s)<-[:FOLLOWS]-() | 1]) AS incoming',
    ].join('\n'),
    { memberId: probe.memberId, workspaceId: probe.workspaceId },
    (row) => ({
      id: row.id as string,
      outgoing: row.outgoing as number,
      incoming: row.incoming as number,
    }),
  );

  const cycles = await runRead(
    probe.substrate.harness.driver,
    'MATCH path = (s:Session)-[:FOLLOWS*1..40]->(s) RETURN count(path) AS c',
    {},
    (row) => row.c as number,
  );

  expect(links.length).toBeGreaterThanOrEqual(
    SEQUENTIAL_ATTEMPTS + CONCURRENT_ATTEMPTS * 2 + CONCURRENT_CREATIONS,
  );
  expect(links.filter((link) => link.outgoing > 1)).toEqual([]);
  expect(links.filter((link) => link.incoming > 1)).toEqual([]);
  expect(links.filter((link) => link.outgoing === 0)).toHaveLength(1);
  expect(links.filter((link) => link.incoming === 0)).toHaveLength(1);
  expect(cycles).toEqual([0]);
}, 300_000);
