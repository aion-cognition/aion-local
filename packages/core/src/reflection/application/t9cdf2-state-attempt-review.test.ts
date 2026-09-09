import { afterEach, beforeEach, expect, it } from 'vitest';

import { planMemberAttempt } from './legacy-attempts.js';
import { applySourceVerification } from './legacy-verification.js';
import { commitSourceState, seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import { isSourceForgotten } from '../../infrastructure/sqlite/source-lifecycle.js';

let store: SqliteStore;
const NOW = new Date('2026-01-01T00:00:00.000Z');
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});
afterEach(() => {
  store.close();
});

function prepared(operationId: string, payload: unknown = {}) {
  preparePublicationIntent(store.db, {
    operationId,
    kind: 'legacy_materialization',
    payloadDigest: operationId,
    payloadJson: JSON.stringify(payload),
    expectedJson: '{}',
    affectedScopesJson: '[]',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
}
function acknowledged(operationId: string) {
  acknowledgePublicationIntent(store.db, {
    operationId,
    resultDigest: operationId,
    resultJson: '{"verified":true,"pinned":false,"reason":"proved"}',
    observedAckAt: NOW,
  });
}
it('does not discard a legacy forget because an independent suppression family has history', () => {
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'test',
    content: { observations: ['raw'] },
    now: NOW,
  });
  commitSourceState(store.db, {
    sourceId: 'source',
    stateKind: 'suppressed',
    operationId: 'suppress',
    at: NOW,
  });
  commitSourceState(store.db, {
    sourceId: 'source',
    stateKind: 'unsuppressed',
    operationId: 'unsuppress',
    at: new Date(NOW.getTime() + 1000),
  });
  prepared('legacy-forget');
  applySourceVerification(
    store.db,
    {
      sourceId: 'source',
      status: 'verified',
      reason: 'legacy baseline',
      forgottenAt: NOW.toISOString(),
    },
    { operationId: 'legacy-forget', knownFrom: new Date(NOW.getTime() + 2000) },
  );
  acknowledged('legacy-forget');
  expect(isSourceForgotten(store.db, 'source')).toBe(true);
});
it('does not fall back behind a later terminal attempt to an older acknowledgment', () => {
  const id = 'legacy-materialization:cohort:source';
  prepared(id);
  acknowledged(id);
  prepared(`${id}#2`);
  store.db
    .prepare("UPDATE publication_intents SET state='rejected',error='moved' WHERE operation_id=?")
    .run(`${id}#2`);
  const next = planMemberAttempt(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    payload: { marker: 'new' },
    status: 'accounted',
    reverify: false,
  });
  expect(next.receipt).toBeUndefined();
  expect(next.operationId).toBe(`${id}#3`);
});
it('keeps the ordinary acknowledged-but-unfinalized control on its receipt', () => {
  const id = 'legacy-materialization:cohort:source';
  prepared(id);
  acknowledged(id);
  expect(
    planMemberAttempt(store.db, {
      cohortId: 'cohort',
      sourceId: 'source',
      payload: { marker: 'new' },
      status: 'accounted',
      reverify: false,
    }),
  ).toMatchObject({ operationId: id, receipt: { verified: true } });
});
it('keeps the saved request of a genuinely pending attempt', () => {
  const id = 'legacy-materialization:cohort:source';
  prepared(id, { marker: 'old' });
  expect(
    planMemberAttempt(store.db, {
      cohortId: 'cohort',
      sourceId: 'source',
      payload: { marker: 'new' },
      status: 'accounted',
      reverify: false,
    }),
  ).toMatchObject({ operationId: id, payload: { marker: 'old' } });
});
