import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PublicationCoordinator } from './coordinator.js';
import { activateCoverageOnStart } from './coverage-activation.js';
import { PUBLICATION_HANDLERS } from './handlers.js';
import { checkCoverage } from '../../recall/application/coverage-checker.js';
import { durableEligibility } from '../../reflection/application/eviction-eligibility.js';
import { runGraphMigrations } from '../graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../graph/test-support/consolidation-rehearsal.fixture.js';
import { readCurrentCoverageContract } from '../sqlite/coverage-contract.js';
import { SqliteStore } from '../sqlite/database.js';
import { readSubstratePairing } from '../sqlite/publication-control.js';

/**
 * A fresh substrate taken through the step an ordinary service start takes, against the real
 * coordinator and a real graph.
 *
 * Nothing here is seeded into an end state. Initialization opens the contract preparing exactly
 * as it does on a first boot, the activation publishes through the coordinator, and every claim
 * is read back from the records afterwards.
 */

const NOW = new Date('2026-09-11T06:00:00.000Z');
const BEFORE = new Date('2020-01-01T00:00:00.000Z');
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-coverage-activation-int-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS],
    now: () => NOW,
  });
  await coordinator.initialize();
}, 120_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

function read(knewAt?: string) {
  return checkCoverage(store.db, {
    now: NOW,
    expiryAnnotation: false,
    ...(knewAt === undefined ? {} : { knewAt }),
  });
}

it('serves a prepared contract as partial with no horizon and no invented boundary', () => {
  expect(readCurrentCoverageContract(store.db)).toMatchObject({
    state: 'preparing',
    historySince: null,
    activatedAt: null,
  });

  const before = read(BEFORE.toISOString());

  expect(before).toMatchObject({
    status: 'checked',
    coverage: { status: 'partial', limitations: ['coverage_contract_not_active'] },
  });
  expect(before.status === 'checked' && 'history_since' in before.coverage).toBe(false);
});

it('activates the contract on a start and answers temporal reads from the horizon it wrote', async () => {
  const activated = await activateCoverageOnStart(coordinator, store.db);

  expect(activated).toEqual({ state: 'active', historySince: NOW.toISOString() });
  expect(readCurrentCoverageContract(store.db)).toMatchObject({
    state: 'active',
    historySince: NOW.toISOString(),
    activatedAt: NOW.toISOString(),
  });

  const current = read();

  expect(current).toMatchObject({
    status: 'checked',
    coverage: { status: 'supported', history_since: NOW.toISOString(), limitations: [] },
  });
});

it('refuses a knowledge time behind the horizon, which a prepared contract could never do', () => {
  expect(read(BEFORE.toISOString())).toMatchObject({
    status: 'refused',
    refusal: {
      reason: 'before_horizon',
      bounds: { coverage_state: 'active', history_since: NOW.toISOString() },
    },
  });
});

it('adds no revision and no second operation when a later start runs the same step', async () => {
  const before = readCurrentCoverageContract(store.db);
  const operations = store.db
    .prepare("SELECT COUNT(*) AS count FROM publication_intents WHERE kind = 'coverage_activation'")
    .get() as { count: number };

  const repeated = await activateCoverageOnStart(coordinator, store.db);

  expect(repeated).toEqual({ state: 'active', historySince: NOW.toISOString() });
  expect(readCurrentCoverageContract(store.db)).toEqual(before);
  expect(
    store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM publication_intents WHERE kind = 'coverage_activation'",
      )
      .get(),
  ).toEqual(operations);
});

it('leaves eviction refusing every source with the contract active', () => {
  expect(readSubstratePairing(store.db)).toMatchObject({
    activationCapabilityRevision: 1,
    evictionCompatibilityRevision: 0,
  });

  expect(durableEligibility(store.db, 'any-source', { now: NOW, minAgeMs: 0 })).toEqual({
    status: 'pinned',
    reason: 'compatibility_not_established',
  });
});
