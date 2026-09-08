import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { checkCoverage, type CheckedRead } from './coverage-checker.js';
import { completeCheckedRead, type CheckedReadEffects } from './read-completion.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  ProbePublication,
  seedPublicationProbe,
  type ProbePayload,
} from '../../infrastructure/graph/test-support/publication-operation.fixture.js';
import {
  PublicationCoordinator,
  type PublicationRequest,
} from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type {
  PublicationBoundary,
  PublicationCheckpoint,
} from '../../infrastructure/publication/types.js';
import { activateCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  deleteServedItems,
  readServedItems,
  recordServedItems,
} from '../../infrastructure/sqlite/served-items.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const SESSION = 'session-1';
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let failAt: PublicationBoundary | undefined;
let serial = 0;
let completions = 0;
let request: PublicationRequest;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-read-completion-int-'));
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
}, 60_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  failAt = undefined;
  serial += 1;
  const nodeId = `read-completion-${String(serial)}`;
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  const payload: ProbePayload = { nodeId, value: 'published', expectedVersion: 0, expectedScope };
  request = { kind: 'semantic_write', operationId: `operation-${String(serial)}`, payload };
  deleteServedItems(store.db, SESSION);
  recordServedItems(store.db, SESSION, [{ itemId: 'node-1', fingerprint: 'a' }], NOW.toISOString());
});

function checked(): CheckedRead {
  const result = checkCoverage(store.db, { now: NOW, expiryAnnotation: true });
  if (result.status !== 'checked') {
    throw new Error('the substrate carries a readable coverage record');
  }
  return { context: result.context, coverage: result.coverage };
}

async function position(): Promise<PublicationCheckpoint> {
  const taken = await coordinator.checkpoint();
  if (taken.status !== 'ready') {
    throw new Error(`no checkpoint: ${taken.reason}`);
  }
  return taken.checkpoint;
}

function effects(read: CheckedRead, checkpoint: PublicationCheckpoint): CheckedReadEffects<number> {
  return {
    read,
    checkpoint,
    resetDelivery: (db) => {
      deleteServedItems(db, SESSION);
    },
    persist: (db) => {
      completions += 1;
      markLedgerApplied(db, `read-completed:${String(serial)}`, completions);
      return completions;
    },
  };
}

function persisted(): unknown {
  return getLedgerEntry(store.db, `read-completed:${String(serial)}`)?.summary;
}

describe('a checked read against both stores', () => {
  it('commits its effects and its staged reset together', async () => {
    const outcome = await completeCheckedRead(coordinator, effects(checked(), await position()));

    expect(outcome.status).toBe('completed');
    expect(persisted()).toBe(completions);
    expect(readServedItems(store.db, SESSION).size).toBe(0);
  });

  it('holds the effects back on a position a publication has moved past', async () => {
    const stale = await position();
    const read = checked();
    expect(await coordinator.publish(request)).toMatchObject({ status: 'acknowledged' });

    const outcome = await completeCheckedRead(coordinator, effects(read, stale));

    expect(outcome).toMatchObject({ status: 'retry', reason: 'publication_changed' });
    expect(persisted()).toBeUndefined();
    expect(readServedItems(store.db, SESSION).size).toBe(1);
  });

  it('degrades promptly while a publication is pending, without waiting for its recovery', async () => {
    const read = checked();
    const taken = await position();
    failAt = 'prepared';
    await expect(coordinator.publish(request)).rejects.toThrow();
    expect(coordinator.hasPending()).toBe(true);

    const started = performance.now();
    const outcome = await completeCheckedRead(coordinator, effects(read, taken));

    expect(outcome).toEqual({ status: 'retry', reason: 'pending_publication' });
    expect(performance.now() - started).toBeLessThan(500);
    expect(persisted()).toBeUndefined();
    expect(readServedItems(store.db, SESSION).size).toBe(1);
    expect(await coordinator.recover()).toMatchObject({ status: 'acknowledged' });
  }, 25_000);

  it('refuses when the coverage record is revised between the position and the boundary', async () => {
    const read = checked();
    const taken = await position();
    activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });

    const outcome = await completeCheckedRead(coordinator, effects(read, taken));

    expect(outcome).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_changed', requested: { now: NOW.toISOString() } },
    });
    expect(persisted()).toBeUndefined();
    expect(readServedItems(store.db, SESSION).size).toBe(1);
  });

  it('commits a rebuilt result under the contract that replaced the checked one', async () => {
    const read = checked();
    const taken = await position();
    activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });

    const outcome = await completeCheckedRead(coordinator, effects(read, taken), async () => ({
      status: 'reconstructed',
      effects: effects(checked(), await position()),
    }));

    expect(outcome.status).toBe('completed');
    expect(persisted()).toBe(completions);
    expect(readServedItems(store.db, SESSION).size).toBe(0);
  });
});
