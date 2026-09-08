import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { runGraphMigrations } from './migrations.js';
import { publicationGuardIdentities, readPublicationGuard } from './publication-receipt.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { SqliteStore } from '../sqlite/database.js';
import { coordinatorControl } from '../sqlite/publication-coordinator-store.js';

let dir: string;
let substrate: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-publication-init-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    handlers: [],
    logger: { warn: () => undefined, error: () => undefined },
  });
}, 60_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('requires the migration-owned constraint before creating any bootstrap records', async () => {
  const before = store.db.prepare('SELECT total_changes() AS changes').get();
  const calls = vi.spyOn(substrate.harness.driver, 'executeQuery');
  await expect(coordinator.initialize()).rejects.toMatchObject({
    reason: 'publication_guard_schema_missing',
  });
  expect(store.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before);
  expect(await publicationGuardIdentities(substrate.harness.driver)).toEqual([]);
  expect(
    calls.mock.calls.every(
      ([query]) => typeof query === 'string' && !query.includes('CREATE CONSTRAINT'),
    ),
  ).toBe(true);
  calls.mockRestore();
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  await coordinator.initialize();
});

it('rejoins an initialized pair without SQLite or graph writes', async () => {
  const before = store.db.prepare('SELECT total_changes() AS changes').get();
  const control = coordinatorControl(store.db);
  const guard = await readPublicationGuard(substrate.harness.driver, control.substrateId, 1000);
  const calls = vi.spyOn(substrate.harness.driver, 'executeQuery');
  await coordinator.initialize();
  expect(store.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before);
  expect(await readPublicationGuard(substrate.harness.driver, control.substrateId, 1000)).toEqual(
    guard,
  );
  expect(
    calls.mock.calls.every(
      ([query]) => typeof query === 'string' && !query.includes('CREATE CONSTRAINT'),
    ),
  ).toBe(true);
  calls.mockRestore();
});

it('refuses receipt skew before any SQLite transaction or graph mutation', async () => {
  const control = coordinatorControl(store.db);
  await substrate.harness.driver.executeQuery(
    'MATCH (g:PublicationGuard {substrate_id: $id}) SET g.sequence = $sequence',
    { id: control.substrateId, sequence: '5' },
  );
  const before = store.db.prepare('SELECT total_changes() AS changes').get();
  const transactions = vi.spyOn(store.db, 'transaction');
  const calls = vi.spyOn(substrate.harness.driver, 'executeQuery');
  const guard = await readPublicationGuard(substrate.harness.driver, control.substrateId, 1000);
  try {
    await expect(coordinator.initialize()).rejects.toMatchObject({
      reason: 'publication_pair_out_of_sync',
    });
    expect(transactions).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before);
    expect(await readPublicationGuard(substrate.harness.driver, control.substrateId, 1000)).toEqual(
      guard,
    );
    expect(
      calls.mock.calls.every(
        ([query]) => typeof query === 'string' && !query.includes('CREATE CONSTRAINT'),
      ),
    ).toBe(true);
  } finally {
    transactions.mockRestore();
    calls.mockRestore();
    await substrate.harness.driver.executeQuery(
      'MATCH (g:PublicationGuard {substrate_id: $id}) SET g.sequence = $sequence',
      { id: control.substrateId, sequence: '0' },
    );
  }
});

it('refuses an unfinished pairing with a non-initial receipt before creating coverage', async () => {
  store.db.prepare("UPDATE publication_control SET bootstrap_state = 'pairing'").run();
  store.db.prepare('DELETE FROM coverage_contract').run();
  const control = coordinatorControl(store.db);
  await substrate.harness.driver.executeQuery(
    'MATCH (g:PublicationGuard {substrate_id: $id}) SET g.sequence = $sequence',
    { id: control.substrateId, sequence: '5' },
  );
  const before = store.db.prepare('SELECT total_changes() AS changes').get();
  await expect(coordinator.initialize()).rejects.toMatchObject({
    reason: 'publication_initial_receipt_invalid',
  });
  expect(store.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before);
  expect(store.db.prepare('SELECT 1 FROM coverage_contract').get()).toBeUndefined();
});
