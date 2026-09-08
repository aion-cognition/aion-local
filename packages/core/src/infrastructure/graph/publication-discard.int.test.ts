import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import {
  overwriteProbeVersion,
  ProbePublication,
  seedPublicationProbe,
} from './test-support/publication-operation.fixture.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import type { PublicationBoundary } from '../publication/types.js';
import { SqliteStore } from '../sqlite/database.js';
import { getLedgerEntry } from '../sqlite/ops-ledger.js';
import { listPendingEffects } from '../sqlite/publication-intents.js';
import { publicationRecord } from '../sqlite/publication-coordinator-store.js';

const logger = { warn: () => undefined, error: () => undefined };

let dir: string;
let substrate: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let failAt: PublicationBoundary | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-adv-effects-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [new ProbePublication(), ...PUBLICATION_HANDLERS],
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted publication');
      }
    },
  });
  await coordinator.initialize();
}, 180_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('an acknowledged operation owes nothing afterwards', async () => {
  const nodeId = 'effects-acknowledged';
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  await coordinator.publish({
    kind: 'semantic_write',
    operationId: nodeId,
    payload: { nodeId, value: 'done', expectedVersion: 0, expectedScope },
  });
  expect(listPendingEffects(store.db, nodeId)).toEqual([]);
});

it.each(['prepared', 'graph_result_saved'] as const)(
  'settles unpublished effects after %s',
  async (boundary) => {
    const nodeId = `effects-deferred-${boundary}`;
    const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
    failAt = boundary;
    await expect(
      coordinator.publish({
        kind: 'semantic_write',
        operationId: nodeId,
        payload: { nodeId, value: 'deferred', expectedVersion: 0, expectedScope },
      }),
    ).rejects.toThrow();
    expect(listPendingEffects(store.db, nodeId)).toEqual(['acknowledgment']);
    expect(publicationRecord(store.db, nodeId)?.resultJson === null).toBe(boundary === 'prepared');

    await overwriteProbeVersion(substrate.harness.driver, nodeId, 4);
    expect(await coordinator.recover()).toMatchObject({ status: 'deferred' });
    expect(publicationRecord(store.db, nodeId)?.state).toBe('deferred');
    // The operation is settled and will never acknowledge, so it owes nothing.
    expect(listPendingEffects(store.db, nodeId)).toEqual([]);
    expect(publicationRecord(store.db, nodeId)?.resultJson).toBeNull();
    expect(publicationRecord(store.db, nodeId)?.resultDigest).toBeNull();
    expect(getLedgerEntry(store.db, `accepted:${nodeId}`)).toBeDefined();
  },
);
