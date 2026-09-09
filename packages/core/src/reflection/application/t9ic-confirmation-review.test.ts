import { expect, it } from 'vitest';

import { CONFIRMATION_SIGNAL_EFFECT, settleConfirmationSignals } from './confirmation-signals.js';
import {
  prepareReferenceAcceptance,
  acknowledgeReferenceAcceptance,
  type ReferenceTargetPlan,
} from './reference-acceptance.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  preparePublicationIntent,
  acknowledgePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import { listEvidenceAcknowledgments } from '../../infrastructure/sqlite/source-lifecycle.js';

const AT = new Date('2026-09-01T00:00:00.000Z');

it.each([
  ['a-known', 'z-unknown'],
  ['z-known', 'a-unknown'],
])('keeps a mixed confirmation batch owed regardless of target order: %s', (known, unknown) => {
  const store = new SqliteStore({ filePath: ':memory:' });
  try {
    for (const id of ['source', known]) {
      seedSource(store.db, {
        sourceId: id,
        sessionId: 'session',
        identity: id,
        content: { observations: [id] },
        now: AT,
      });
    }
    const targets: ReferenceTargetPlan[] = [
      {
        id: known,
        kind: 'confirms',
        targetClass: 'source',
        confirmation: { by: 'reviewer', evidence: 'known', occurredAt: AT.toISOString() },
      },
      {
        id: unknown,
        kind: 'confirms',
        targetClass: 'unresolved',
        confirmation: { by: 'reviewer', evidence: 'unknown', occurredAt: AT.toISOString() },
      },
    ];
    const acceptance = {
      sourceId: 'source',
      targets,
      deliveryKey: 'delivery',
      operationId: 'operation',
      acceptedAt: AT.toISOString(),
    };
    const version = store.db
      .transaction(() => {
        preparePublicationIntent(store.db, {
          operationId: acceptance.operationId,
          kind: 'stated_references',
          payloadDigest: 'fixture',
          payloadJson: '{}',
          expectedJson: '{}',
          affectedScopesJson: '[]',
          preparedActionsJson: '{}',
          createdAt: AT,
        });
        return prepareReferenceAcceptance(store.db, acceptance);
      })
      .immediate();
    store.db
      .transaction(() => {
        acknowledgeReferenceAcceptance(store.db, {
          ...acceptance,
          referenceVersion: version,
          knownFrom: AT.toISOString(),
          observedAckAt: AT.toISOString(),
        });
        acknowledgePublicationIntent(store.db, {
          operationId: acceptance.operationId,
          resultDigest: 'fixture',
          resultJson: '{}',
          observedAckAt: AT,
        });
      })
      .immediate();
    const signal = () =>
      listEvidenceAcknowledgments(store.db, 'source').find(
        (row) => row.effectKind === CONFIRMATION_SIGNAL_EFFECT,
      );
    expect.soft(signal()?.state).toBe('owed');
    expect(
      store.db
        .prepare("SELECT count(*) AS n FROM usage_events WHERE kind='memory_confirmed'")
        .get(),
    ).toEqual({ n: 1 });
    seedSource(store.db, {
      sourceId: unknown,
      sessionId: 'session',
      identity: unknown,
      content: { observations: [unknown] },
      now: AT,
    });
    store.db
      .transaction(() => {
        settleConfirmationSignals(store.db, {
          sourceId: 'source',
          referenceVersion: version,
          observedAckAt: AT.toISOString(),
        });
      })
      .immediate();
    expect(signal()?.state).toBe('completed');
    expect(
      store.db
        .prepare("SELECT count(*) AS n FROM usage_events WHERE kind='memory_confirmed'")
        .get(),
    ).toEqual({ n: 2 });
  } finally {
    store.close();
  }
});
