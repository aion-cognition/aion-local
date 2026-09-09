import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  publishIntake,
  startIntakeProbe,
  stopIntakeProbe,
  type IntakeProbe,
} from './test-support/session-intake.fixture.js';
import { listSourcePublications, readPublicationReceipt } from '../sqlite/publication-intents.js';
import { readSourceRecord } from '../sqlite/source-identity.js';

let probe: IntakeProbe;
beforeAll(async () => {
  probe = await startIntakeProbe({ prefix: 'aion-timeline-intake-' });
}, 300_000);
afterAll(async () => {
  await stopIntakeProbe(probe);
});

it('includes the actual intake publication for an ordinary source with no stated references', async () => {
  const identity = 'timeline-unreferenced-intake';
  const at = new Date();
  await probe.sessions.ensureSession({ identity, now: at, occurredAt: at });
  const operationId = 'intake:timeline-unreferenced';
  const outcome = await publishIntake(probe, {
    identity,
    marker: identity,
    operationId,
    occurredAt: at,
  });
  if (outcome.status !== 'acknowledged') {
    throw new Error(`intake did not acknowledge: ${JSON.stringify(outcome)}`);
  }
  const { sourceId } = outcome.result as { sourceId: string };
  expect(readSourceRecord(probe.store.db, sourceId)?.verificationStatus).toBe('verified');
  expect(readPublicationReceipt(probe.store.db, operationId)?.state).toBe('acknowledged');
  expect(listSourcePublications(probe.store.db, sourceId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operationId,
        state: 'acknowledged',
        sequence: outcome.sequence,
        knownFrom: outcome.knownFrom,
        observedAckAt: outcome.observedAckAt,
      }),
    ]),
  );
});
