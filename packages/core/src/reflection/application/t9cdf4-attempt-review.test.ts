import { afterEach, beforeEach, expect, it } from 'vitest';

import { MAX_REPAIR_ATTEMPTS, planMemberAttempt } from './legacy-attempts.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';

let store: SqliteStore;
const NOW = new Date('2026-01-01T00:00:00.000Z');
const BASE = 'legacy-materialization:cohort:source';
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});
afterEach(() => {
  store.close();
});
function record(id: string, state: 'acknowledged' | 'rejected'): void {
  preparePublicationIntent(store.db, {
    operationId: id,
    kind: 'legacy_materialization',
    payloadDigest: id,
    payloadJson: '{}',
    expectedJson: '{}',
    affectedScopesJson: '[]',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
  if (state === 'rejected') {
    store.db
      .prepare("UPDATE publication_intents SET state='rejected',error='moved' WHERE operation_id=?")
      .run(id);
    return;
  }
  acknowledgePublicationIntent(store.db, {
    operationId: id,
    resultDigest: id,
    resultJson: '{"verified":true,"pinned":true,"reason":"same pin"}',
    observedAckAt: NOW,
  });
}
it('does not infer a legacy association from matching verdicts separated by a terminal attempt', () => {
  record(BASE, 'acknowledged');
  record(`${BASE}#2`, 'rejected');
  record(`${BASE}#3`, 'acknowledged');
  const next = planMemberAttempt(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    payload: {},
    status: 'pinned',
    reason: 'same pin',
    reverify: true,
  });
  expect.soft(next.operationId).toBe(`${BASE}#3`);
  expect.soft(next.associate).toBeUndefined();
  expect.soft(next.receipt).toMatchObject({ pinned: true });
});
it('recovers the last allowed acknowledgment before applying the new-attempt limit', () => {
  for (let n = 1; n <= MAX_REPAIR_ATTEMPTS; n += 1) {
    record(
      n === 1 ? BASE : `${BASE}#${n}`,
      n === MAX_REPAIR_ATTEMPTS ? 'acknowledged' : 'rejected',
    );
  }
  const next = planMemberAttempt(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    payload: {},
    status: 'accounted',
    reverify: false,
  });
  expect.soft(next.exhausted).toBeUndefined();
  expect.soft(next.operationId).toBe(`${BASE}#${MAX_REPAIR_ATTEMPTS}`);
  expect.soft(next.receipt).toMatchObject({ pinned: true });
  const accounted = planMemberAttempt(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    payload: {},
    status: 'pinned',
    reason: 'same pin',
    walkedBy: `${BASE}#${MAX_REPAIR_ATTEMPTS}`,
    reverify: true,
  });
  expect(accounted.exhausted).toBeDefined();
});
