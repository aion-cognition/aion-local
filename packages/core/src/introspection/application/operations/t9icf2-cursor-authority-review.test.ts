import { ReflectionInputSchema } from '@aion/protocol/reflection-input.js';
import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { expect, it, vi } from 'vitest';

import { confirmationSignalCompletionOperation } from './confirmation-signal-completion.js';
import { seedSource } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import {
  preparePublicationIntent,
  acknowledgePublicationIntent,
} from '../../../infrastructure/sqlite/publication-intents.js';
import {
  prepareReferenceAcceptance,
  acknowledgeReferenceAcceptance,
} from '../../../reflection/application/reference-acceptance.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

const AT = new Date('2026-09-01T00:00:00.000Z');

it('resumes a deferred page from disk after recreating both the store and operation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aion-signal-cursor-'));
  const filePath = join(dir, 'store.sqlite');
  let store = new SqliteStore({ filePath });
  try {
    for (let index = 0; index < 26; index += 1) {
      const id = `source-${String(index).padStart(2, '0')}`;
      seedSource(store.db, {
        sourceId: id,
        sessionId: 'session',
        identity: id,
        content: { observations: [id] },
        now: AT,
      });
      const acceptance = {
        sourceId: id,
        operationId: `accept-${id}`,
        deliveryKey: `delivery-${id}`,
        acceptedAt: AT.toISOString(),
        targets: [
          {
            id: `target-${id}`,
            kind: 'confirms' as const,
            targetClass: 'unresolved' as const,
            confirmation: { by: 'reviewer', evidence: id, occurredAt: AT.toISOString() },
          },
        ],
      };
      store.db
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
          const referenceVersion = prepareReferenceAcceptance(store.db, acceptance);
          acknowledgeReferenceAcceptance(store.db, {
            ...acceptance,
            referenceVersion,
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
    }
    seedSource(store.db, {
      sourceId: 'target-source-25',
      sessionId: 'session',
      identity: 'resolved-tail',
      content: { observations: ['the last target is now held'] },
      now: AT,
    });
    const visited: string[] = [];
    const publish = vi.fn(async (request: { operationId: string; payload: unknown }) => {
      visited.push((request.payload as { sourceId: string }).sourceId);
      return {
        status: 'deferred' as const,
        operationId: request.operationId,
        sequence: '1',
        reason: 'earlier_work_still_owed',
      };
    });
    const ctx: OperationContext = {
      driver: {} as Driver,
      db: store.db,
      config: DEFAULTS,
      logger: pino({ enabled: false }),
      provider: {
        embed: () => Promise.reject(new Error('no embedding')),
        generate: () => Promise.reject(new Error('no generation')),
      },
      references: { publish },
      health: healthFixture(),
      now: AT,
      signal: new AbortController().signal,
    };
    for (let pass = 0; pass < 3; pass += 1) {
      if (pass > 0) {
        store.close();
        store = new SqliteStore({ filePath });
      }
      await confirmationSignalCompletionOperation().run({
        ...ctx,
        db: store.db,
        now: new Date(AT.getTime() + pass * 60 * 60 * 1000),
      });
    }
    console.log(
      JSON.stringify({
        event: 'repair_pagination',
        calls: publish.mock.calls.length,
        uniqueSources: new Set(visited).size,
      }),
    );
    expect(publish.mock.calls.length).toBeLessThanOrEqual(75);
    expect(visited).toContain('source-00');
    expect(visited).toContain('source-25');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('does not let a public reflection supply an internal resolved confirmation clock', () => {
  const confirmation = { target: 'target', by: 'caller', evidence: 'reference' };
  const payload = {
    observations: ['confirmed a memory'],
    provenance: { confirmations: [confirmation] },
  };
  expect(ReflectionInputSchema.safeParse(payload).success).toBe(true);
  expect(
    ReflectionInputSchema.safeParse({
      ...payload,
      provenance: {
        confirmations: [{ ...confirmation, resolvedOccurredAt: '2020-01-01T00:00:00.000Z' }],
      },
    }).success,
  ).toBe(false);
  expect(
    ReflectionInputSchema.safeParse({
      ...payload,
      provenance: { confirmations: [{ ...confirmation, occurred_at: '2020-01-01T00:00:00.000Z' }] },
    }).success,
  ).toBe(true);
});
