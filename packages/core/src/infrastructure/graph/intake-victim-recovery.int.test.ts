import { afterAll, beforeAll, expect, it } from 'vitest';

import { episodeIdsInSession, turnsOfEpisode } from './test-support/graph-queries.fixture.js';
import {
  archiveKeyFor,
  archivedRows,
  DEADLOCK_CODE,
  errorChain,
  intakeFailingAfterProjection,
  publishIntake,
  snapshotOf,
  startIntakeProbe,
  stopIntakeProbe,
  type ArmedIntake,
  type IntakeProbe,
  type PublicationSnapshot,
} from './test-support/session-intake.fixture.js';
import { PublicationRetryableError } from '../publication/errors.js';
import type { PublicationOutcome } from '../publication/types.js';
import { publicationRecord, coordinatorControl } from '../sqlite/publication-coordinator-store.js';
import { listReflectionJobs } from '../sqlite/reflection-queue.js';
import { occurrenceCandidates } from '../sqlite/source-occurrence.js';

/**
 * What survives a store failure that lands after the graph half ran and before it committed.
 * The failure is injected, because the lock inversion that used to produce it is gone; it
 * carries the store's own deadlock code, so it takes the classification route a real one took.
 *
 * Five properties, in the order a caller meets them: the answer names a retryable store
 * failure, the accepted input is still durable, the coordinator can settle it, a retry
 * duplicates nothing, and an operator who never calls anything still gets the episode because
 * the next ordinary publication settles the pending slot on its way past.
 */

const EXPLICIT = { identity: 'victim-explicit', marker: 'victim-explicit' } as const;
const PASSIVE = { identity: 'victim-passive', marker: 'victim-passive' } as const;
const FOLLOWER = { identity: 'follower', marker: 'follower' } as const;

let armed: ArmedIntake;
let probe: IntakeProbe;
let rejection: unknown;
let atFailure: PublicationSnapshot;
let recoveredSourceId: string;
/** The bytes the refused delivery carried, which a verbatim replay has to resend. */
let refusedOccurredAt: Date;

beforeAll(async () => {
  armed = intakeFailingAfterProjection();
  probe = await startIntakeProbe({ prefix: 'aion-intake-victim-', handler: armed.handler });
}, 300_000);

afterAll(async () => {
  await stopIntakeProbe(probe);
});

type IntakeResult = {
  readonly sourceId: string;
  readonly created: boolean;
  readonly turnIds: readonly string[];
};

function resultOf(outcome: PublicationOutcome | undefined): IntakeResult {
  if (outcome?.status !== 'acknowledged') {
    throw new Error(`expected an acknowledgment, got ${JSON.stringify(outcome)}`);
  }
  return outcome.result as unknown as IntakeResult;
}

type RefusedFlow = { readonly error: unknown; readonly occurredAt: Date };

/** One client flow whose graph write is refused, with the fault armed for exactly this call. */
async function failingFlow(input: { identity: string; marker: string }): Promise<RefusedFlow> {
  const occurredAt = new Date();
  await probe.sessions.ensureSession({
    identity: input.identity,
    now: occurredAt,
    occurredAt,
  });
  armed.arm();
  try {
    await publishIntake(probe, {
      ...input,
      operationId: `intake:${input.identity}`,
      occurredAt,
    });
  } catch (err) {
    return { error: err, occurredAt };
  } finally {
    armed.disarm();
  }
  throw new Error(`${input.identity} published despite an armed store failure`);
}

it('answers a store failure with a retryable publication error, not a corruption claim', async () => {
  const refused = await failingFlow(EXPLICIT);
  rejection = refused.error;
  refusedOccurredAt = refused.occurredAt;
  atFailure = await snapshotOf(probe, EXPLICIT.identity, `intake:${EXPLICIT.identity}`);

  expect(rejection).toBeInstanceOf(PublicationRetryableError);
  const error = rejection as PublicationRetryableError;
  expect(error.name).toBe('PublicationRetryableError');
  expect(error.retryable).toBe(true);
  expect(error.reason).toBe('store_unavailable');
  expect(errorChain(rejection)).toContain(DEADLOCK_CODE);
}, 180_000);

it('leaves the accepted input durable and the operation recoverable', () => {
  expect(atFailure.state).toBe('prepared');
  expect(atFailure.pending).toBe(`intake:${EXPLICIT.identity}`);
  expect(atFailure.archived).toBe(1);
  // The graph half rolled back whole, so there is no partial episode to reconcile.
  expect(atFailure.graphEpisodes).toEqual([]);
});

it('settles the pending publication when the coordinator is asked to recover', async () => {
  const outcome = await probe.coordinator.recover();
  const result = resultOf(outcome);
  recoveredSourceId = result.sourceId;

  const record = publicationRecord(probe.store.db, `intake:${EXPLICIT.identity}`);
  const episodes = await episodeIdsInSession(probe.substrate.harness.driver, EXPLICIT.identity);
  const turns = await turnsOfEpisode(probe.substrate.harness.driver, result.sourceId);

  expect(record?.state).toBe('acknowledged');
  expect(coordinatorControl(probe.store.db).pendingOperationId).toBeNull();
  expect(episodes).toEqual([result.sourceId]);
  expect(turns).toHaveLength(2);
}, 180_000);

/**
 * Both retries a client can make. The same delivery identity must carry identical bytes: a
 * replay under that id with anything else is refused as identity reuse, so a retry helper has
 * to resend the original request rather than rebuild it.
 */
it('duplicates nothing when the delivery is retried after recovery', async () => {
  const key = {
    identityHash: archiveKeyFor(EXPLICIT.identity, EXPLICIT.marker),
    sessionId: EXPLICIT.identity,
  };
  const measure = async (): Promise<Record<string, unknown>> => ({
    episodes: await episodeIdsInSession(probe.substrate.harness.driver, EXPLICIT.identity),
    candidates: [...occurrenceCandidates(probe.store.db, key)],
    jobs: listReflectionJobs(probe.store.db).length,
    archived: archivedRows(probe.store, EXPLICIT.identity),
  });

  const before = await measure();
  const replayed = await publishIntake(probe, {
    ...EXPLICIT,
    operationId: `intake:${EXPLICIT.identity}`,
    occurredAt: refusedOccurredAt,
  });
  const repushed = await publishIntake(probe, {
    ...EXPLICIT,
    operationId: `intake:${EXPLICIT.identity}:retry`,
    occurredAt: refusedOccurredAt,
  });
  const after = await measure();

  expect(replayed.status).toBe('acknowledged');
  expect(resultOf(replayed).sourceId).toBe(recoveredSourceId);
  expect(repushed.status).toBe('acknowledged');
  expect(resultOf(repushed).created).toBe(false);
  expect(resultOf(repushed).sourceId).toBe(recoveredSourceId);
  expect(after.episodes).toEqual(before.episodes);
  expect(after.candidates).toEqual(before.candidates);
  expect(after.archived).toBe(before.archived);
  expect(after.jobs).toBe(before.jobs);
}, 180_000);

/**
 * The case the caller actually lives in. Nobody calls `recover()`: a second client stores
 * something of its own, and the coordinator settles the slot the first one left before serving
 * it. The first client was told the store failed and its episode lands anyway.
 */
it('settles the pending victim on the next ordinary publication, with no recover call', async () => {
  const refused = await failingFlow(PASSIVE);
  const pendingBefore = coordinatorControl(probe.store.db).pendingOperationId;

  const occurredAt = new Date();
  await probe.sessions.ensureSession({
    identity: FOLLOWER.identity,
    now: occurredAt,
    occurredAt,
  });
  const following = await publishIntake(probe, {
    ...FOLLOWER,
    operationId: `intake:${FOLLOWER.identity}`,
    occurredAt,
  });

  const victimRecord = publicationRecord(probe.store.db, `intake:${PASSIVE.identity}`);
  const victimEpisodes = await episodeIdsInSession(
    probe.substrate.harness.driver,
    PASSIVE.identity,
  );

  expect(refused.error).toBeInstanceOf(PublicationRetryableError);
  expect(pendingBefore).toBe(`intake:${PASSIVE.identity}`);
  expect(following.status).toBe('acknowledged');
  expect(victimRecord?.state).toBe('acknowledged');
  expect(victimEpisodes).toHaveLength(1);
  expect(
    await turnsOfEpisode(probe.substrate.harness.driver, victimEpisodes[0] ?? ''),
  ).toHaveLength(2);
  expect(coordinatorControl(probe.store.db).pendingOperationId).toBeNull();
}, 180_000);
