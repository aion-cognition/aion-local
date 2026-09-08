import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { runGraphMigrations } from './migrations.js';
import { readPublicationGuard } from './publication-receipt.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import {
  ProbePublication,
  seedPublicationProbe,
} from './test-support/publication-operation.fixture.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import type { PublicationBoundary } from '../publication/types.js';
import { SqliteStore } from '../sqlite/database.js';
import { readSubstratePairing } from '../sqlite/publication-control.js';
import { coordinatorControl, publicationRecord } from '../sqlite/publication-coordinator-store.js';
import {
  listAcknowledgedOperations,
  readPublicationReceipt,
} from '../sqlite/publication-intents.js';

const logger = { warn: () => undefined, error: () => undefined };
const NOW = new Date('2026-09-08T06:00:00.000Z');
const UNSAFE = '9007199254740993';

let dir: string;
let substrate: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let failAt: PublicationBoundary | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-adv-sequence-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [new ProbePublication(), ...PUBLICATION_HANDLERS],
    now: () => NOW,
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

it('carries an unsafe sequence through the crash-recovery path', async () => {
  // One ordinary publication first: AUTOINCREMENT has no sqlite_sequence row until an insert.
  const seedId = 'sequence-seed';
  const seedScope = await seedPublicationProbe(substrate.harness.driver, store.db, seedId);
  expect(
    await coordinator.publish({
      kind: 'semantic_write',
      operationId: seedId,
      payload: { nodeId: seedId, value: 'seed', expectedVersion: 0, expectedScope: seedScope },
    }),
  ).toMatchObject({ status: 'acknowledged', sequence: '1' });
  const bumped = store.db
    .prepare(
      "UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = 'publication_intents'",
    )
    .run('9007199254740992').changes;
  expect(bumped).toBe(1);

  const nodeId = 'unsafe-recovered';
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  failAt = 'graph_result_saved';
  await expect(
    coordinator.publish({
      kind: 'semantic_write',
      operationId: nodeId,
      payload: { nodeId, value: 'unsafe', expectedVersion: 0, expectedScope },
    }),
  ).rejects.toThrow();

  expect(publicationRecord(store.db, nodeId)?.sequence).toBe(UNSAFE);
  expect(await coordinator.recover()).toMatchObject({
    status: 'acknowledged',
    sequence: UNSAFE,
  });

  const { substrateId } = coordinatorControl(store.db);
  expect((await readPublicationGuard(substrate.harness.driver, substrateId, 2000)).sequence).toBe(
    UNSAFE,
  );
  expect(coordinatorControl(store.db).lastAckSequence).toBe(UNSAFE);
  expect(await coordinator.checkpoint()).toMatchObject({
    status: 'ready',
    checkpoint: { sequence: UNSAFE },
  });
});

it('orders a successor against the unsafe predecessor', async () => {
  const nodeId = 'unsafe-successor';
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  expect(
    await coordinator.publish({
      kind: 'semantic_write',
      operationId: nodeId,
      payload: { nodeId, value: 'next', expectedVersion: 0, expectedScope },
    }),
  ).toMatchObject({ status: 'acknowledged', sequence: '9007199254740994' });
});

it('reads the unsafe sequence back through the exported journal readers', () => {
  // publication-intents.ts is the durable journal: its readers are the committed-view API.
  expect.soft(String(readPublicationReceipt(store.db, 'unsafe-recovered')?.sequence)).toBe(UNSAFE);
  const acknowledged = listAcknowledgedOperations(store.db).find(
    (row) => row.operationId === 'unsafe-recovered',
  );
  expect.soft(String(acknowledged?.sequence)).toBe(UNSAFE);
});

it('reads an unsafe acknowledgment cursor back through the pairing reader', async () => {
  const nodeId = 'unsafe-cursor';
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  expect(
    await coordinator.publish({
      kind: 'semantic_write',
      operationId: nodeId,
      payload: { nodeId, value: 'cursor', expectedVersion: 0, expectedScope },
    }),
  ).toMatchObject({ status: 'acknowledged', sequence: '9007199254740995' });
  expect(coordinatorControl(store.db).lastAckSequence).toBe('9007199254740995');
  expect(String(readSubstratePairing(store.db)?.lastAckSequence)).toBe('9007199254740995');
});
