import { afterEach, expect, it, vi } from 'vitest';

import { INCOMING_STATEMENT_SCOPES } from './chunk-evidence.js';
import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { intakePublication } from './intake-publication.js';
import { acceptSource, driver, NOW, store } from './test-support/t10b-review.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { readScopeVersion } from '../../infrastructure/sqlite/evidence-scope.js';
import { publicationRecord } from '../../infrastructure/sqlite/publication-coordinator-store.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const logger = { warn: () => undefined, error: () => undefined };

async function payload(marker: string) {
  const anchor = await acceptSource(`anchor:${marker}`, 'session anchor', false);
  const { sessionId } = readSourceRecord(store.db, anchor)!;
  return {
    identity: marker,
    sessionId,
    payloadJson: JSON.stringify({ observations: [marker] }),
    referencesJson: null,
    lane: null,
    originJson: null,
    pipelineVersion: 'fixture',
    occurredAt: NOW.toISOString(),
    indexPolicy: 'fixture',
    readiness: null,
  };
}

function sourceFor(operationId: string): string {
  const row = publicationRecord(store.db, operationId);
  if (row === undefined) {
    throw new Error('prepared intake record absent');
  }
  return (JSON.parse(row.actionsJson) as { data: { sourceId: string } }).data.sourceId;
}

it.each(['prepared', 'before_ack'] as const)(
  'keeps source census unproved at %s and establishes it exactly once through recovery',
  async (point) => {
    const operationId = `scope-recovery:${point}`;
    const input = await payload(operationId);
    let stop: PublicationBoundary | undefined = point;
    const coordinator = new PublicationCoordinator({
      driver,
      db: store.db,
      logger,
      handlers: [...INSTALLED_PUBLICATION_HANDLERS],
      boundary: ({ boundary, operationId: active }) => {
        if (active === operationId && boundary === stop) {
          stop = undefined;
          throw new Error('controlled interruption');
        }
      },
    });
    await coordinator.initialize();
    try {
      await expect(
        coordinator.publish({ kind: 'intake', operationId, payload: input }),
      ).rejects.toThrow();
      const sourceId = sourceFor(operationId);
      for (const scope of INCOMING_STATEMENT_SCOPES) {
        expect(
          readScopeVersion(store.db, { endpointId: sourceId, relationClass: scope }),
        ).toMatchObject({
          censusStatus: 'unknown',
          publishedRevision: 0,
          pendingOperationId: operationId,
        });
      }
      expect((await coordinator.recover())?.status).toBe('acknowledged');
      const { knownFrom } = publicationRecord(store.db, operationId)!;
      for (const scope of INCOMING_STATEMENT_SCOPES) {
        const row = readScopeVersion(store.db, { endpointId: sourceId, relationClass: scope });
        expect(row).toMatchObject({
          censusStatus: 'established',
          publishedRevision: 1,
          pendingOperationId: null,
        });
        expect(JSON.parse(row!.coverageJson!)).toMatchObject({ sourceId, acceptedAt: knownFrom });
      }
      expect(await coordinator.recover()).toBeUndefined();
      expect(
        (await coordinator.publish({ kind: 'intake', operationId, payload: input })).status,
      ).toBe('acknowledged');
      for (const scope of INCOMING_STATEMENT_SCOPES) {
        expect(
          readScopeVersion(store.db, { endpointId: sourceId, relationClass: scope })
            ?.publishedRevision,
        ).toBe(1);
      }
    } finally {
      stop = undefined;
      await coordinator.recover();
    }
  },
);

it('releases prepared source census on a rejected recovery without publishing a baseline', async () => {
  const operationId = 'scope-recovery-discard';
  const input = await payload(operationId);
  let interrupt = true;
  let reject = false;
  const original = intakePublication.check.bind(intakePublication);
  const check = vi
    .spyOn(intakePublication, 'check')
    .mockImplementation((context, plan) =>
      reject && context.operationId === operationId
        ? Promise.resolve({ status: 'rejected', reason: 'controlled_prerequisite_change' })
        : original(context, plan),
    );
  const coordinator = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    boundary: ({ boundary, operationId: active }) => {
      if (active === operationId && boundary === 'prepared' && interrupt) {
        interrupt = false;
        throw new Error('controlled interruption');
      }
    },
  });
  await coordinator.initialize();
  try {
    await expect(
      coordinator.publish({ kind: 'intake', operationId, payload: input }),
    ).rejects.toThrow();
    const sourceId = sourceFor(operationId);
    reject = true;
    expect((await coordinator.recover())?.status).toBe('rejected');
    for (const scope of INCOMING_STATEMENT_SCOPES) {
      expect(
        readScopeVersion(store.db, { endpointId: sourceId, relationClass: scope }),
      ).toMatchObject({
        censusStatus: 'unknown',
        publishedRevision: 0,
        pendingOperationId: null,
        pendingRevision: null,
      });
    }
    expect(coordinator.hasPending()).toBe(false);
  } finally {
    reject = false;
    check.mockRestore();
    await coordinator.recover();
  }
});
