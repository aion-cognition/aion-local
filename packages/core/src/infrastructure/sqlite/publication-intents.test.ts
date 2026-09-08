import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  acknowledgePublicationIntent,
  completeEffect,
  isOperationAcknowledged,
  listAcknowledgedOperations,
  listPendingEffects,
  preparePublicationIntent,
  readPublicationReceipt,
  recordPendingEffect,
  settleUnacknowledgedIntent,
  type PublicationIntent,
} from './publication-intents.js';

const EARLY = new Date('2026-09-08T01:00:00.000Z');
const NOW = new Date('2026-09-08T02:00:00.000Z');

function intent(operationId: string, kind = 'intake'): PublicationIntent {
  return {
    operationId,
    kind,
    payloadDigest: `digest-${operationId}`,
    payloadJson: `{"operation":"${operationId}"}`,
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: EARLY,
  };
}

describe('publication intents', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-intents-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('allocates a sequence per operation and returns the same one to a repeated prepare', () => {
    expect(preparePublicationIntent(store.db, intent('op-1'))).toBe('1');
    expect(preparePublicationIntent(store.db, intent('op-2'))).toBe('2');
    expect(preparePublicationIntent(store.db, intent('op-1'))).toBe('1');
  });

  it('allocates and rereads sequences beyond the JavaScript safe integer range', () => {
    preparePublicationIntent(store.db, intent('seed'));
    store.db
      .prepare(
        "UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = 'publication_intents'",
      )
      .run('9007199254740992');
    expect(preparePublicationIntent(store.db, intent('unsafe'))).toBe('9007199254740993');
    expect(preparePublicationIntent(store.db, intent('unsafe'))).toBe('9007199254740993');
    expect(readPublicationReceipt(store.db, 'unsafe')?.sequence).toBe('9007199254740993');
  });

  it('keeps the prepared input when the result arrives', () => {
    preparePublicationIntent(store.db, intent('op-1'));
    acknowledgePublicationIntent(store.db, {
      operationId: 'op-1',
      resultDigest: 'result-digest',
      resultJson: '{"published":3}',
      observedAckAt: NOW,
    });

    expect(
      store.db
        .prepare('SELECT payload_json, result_json FROM publication_intents WHERE operation_id = ?')
        .get('op-1'),
    ).toEqual({ payload_json: '{"operation":"op-1"}', result_json: '{"published":3}' });
  });

  it('carries both clocks on an operation that wrote no link version and no revision', () => {
    preparePublicationIntent(store.db, intent('activation', 'coverage_activation'));
    const receipt = acknowledgePublicationIntent(store.db, {
      operationId: 'activation',
      resultDigest: 'result-digest',
      resultJson: '{"activated":true}',
      observedAckAt: NOW,
    });

    expect(receipt).toMatchObject({
      knownFrom: NOW.toISOString(),
      observedAckAt: NOW.toISOString(),
      clockClamped: false,
    });
  });

  it('holds a backwards wall clock to its predecessor and keeps the observed time beside it', () => {
    preparePublicationIntent(store.db, intent('op-1'));
    acknowledgePublicationIntent(store.db, {
      operationId: 'op-1',
      resultDigest: 'd1',
      resultJson: '{}',
      observedAckAt: NOW,
    });

    preparePublicationIntent(store.db, intent('op-2'));
    const clamped = acknowledgePublicationIntent(store.db, {
      operationId: 'op-2',
      resultDigest: 'd2',
      resultJson: '{}',
      observedAckAt: EARLY,
    });

    expect(clamped).toMatchObject({
      knownFrom: NOW.toISOString(),
      observedAckAt: EARLY.toISOString(),
      clockClamped: true,
    });
    // Visibility order is the clock first and the sequence after it, so the clamped operation
    // still follows the one it was held back to.
    expect(listAcknowledgedOperations(store.db).map((row) => row.operationId)).toEqual([
      'op-1',
      'op-2',
    ]);
  });

  it('returns the recorded receipt when an acknowledged operation is retried', () => {
    preparePublicationIntent(store.db, intent('op-a'));
    const first = acknowledgePublicationIntent(store.db, {
      operationId: 'op-a',
      resultDigest: 'digest-a',
      resultJson: '{"head":7}',
      observedAckAt: NOW,
    });

    preparePublicationIntent(store.db, intent('op-b'));
    acknowledgePublicationIntent(store.db, {
      operationId: 'op-b',
      resultDigest: 'digest-b',
      resultJson: '{"head":8}',
      observedAckAt: NOW,
    });

    // A retry of the first operation after the second has overwritten the newest receipt.
    const retried = acknowledgePublicationIntent(store.db, {
      operationId: 'op-a',
      resultDigest: 'digest-a',
      resultJson: '{"head":7}',
      observedAckAt: new Date('2026-09-08T05:00:00.000Z'),
    });

    expect(retried).toEqual(first);
    expect(readPublicationReceipt(store.db, 'op-a')).toEqual(first);
  });

  it('refuses to acknowledge an operation nobody prepared or one already settled', () => {
    expect(() =>
      acknowledgePublicationIntent(store.db, {
        operationId: 'absent',
        resultDigest: 'd',
        resultJson: '{}',
        observedAckAt: NOW,
      }),
    ).toThrow(/was never prepared/);

    preparePublicationIntent(store.db, intent('op-1'));
    settleUnacknowledgedIntent(store.db, 'op-1', 'rejected', 'expected head moved');

    expect(() =>
      acknowledgePublicationIntent(store.db, {
        operationId: 'op-1',
        resultDigest: 'd',
        resultJson: '{}',
        observedAckAt: NOW,
      }),
    ).toThrow(/is rejected and cannot acknowledge/);
  });

  it('leaves a deferred operation out of the committed predicate', () => {
    preparePublicationIntent(store.db, intent('op-1'));
    expect(isOperationAcknowledged(store.db, 'op-1')).toBe(false);

    expect(settleUnacknowledgedIntent(store.db, 'op-1', 'deferred', 'store unavailable')).toBe(
      true,
    );
    expect(isOperationAcknowledged(store.db, 'op-1')).toBe(false);
    // Settling twice finds nothing to settle.
    expect(settleUnacknowledgedIntent(store.db, 'op-1', 'deferred', 'store unavailable')).toBe(
      false,
    );
  });

  it('tracks the effects an operation owes until each completes', () => {
    preparePublicationIntent(store.db, intent('op-1'));
    recordPendingEffect(store.db, { operationId: 'op-1', effectKind: 'queue_enqueue' });
    recordPendingEffect(store.db, { operationId: 'op-1', effectKind: 'reference_settlement' });
    recordPendingEffect(store.db, { operationId: 'op-1', effectKind: 'queue_enqueue' });

    expect(listPendingEffects(store.db, 'op-1')).toEqual(['queue_enqueue', 'reference_settlement']);

    expect(completeEffect(store.db, 'op-1', 'queue_enqueue', NOW)).toBe(true);
    expect(completeEffect(store.db, 'op-1', 'queue_enqueue', NOW)).toBe(false);
    expect(listPendingEffects(store.db, 'op-1')).toEqual(['reference_settlement']);
  });
});
