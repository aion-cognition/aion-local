import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

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
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
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
}, 300_000);

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

async function activateThroughCoordinator(): Promise<void> {
  store.db.prepare('UPDATE publication_control SET activation_capability_revision=1').run();
  await coordinator.publish({
    kind: 'coverage_activation',
    operationId: `activation-${serial}`,
    payload: {
      expectedEpoch: readCurrentCoverageContract(store.db)?.epoch,
      capabilityRevision: 1,
      fieldPolicyVersion: 1,
    },
  });
}

it('refuses an epoch change that also advances the real publication checkpoint', async () => {
  const read = checked();
  const checkpoint = await position();
  await activateThroughCoordinator();
  const result = await completeCheckedRead(
    { coordinator, db: store.db },
    effects(read, checkpoint),
  );
  expect(result).toMatchObject({
    status: 'refused',
    refusal: {
      reason: 'coverage_changed',
      bounds: { coverage_state: 'active', history_since: NOW.toISOString() },
    },
  });
  expect(readServedItems(store.db, SESSION).size).toBe(1);
});

it('revalidates after a coordinated epoch change instead of returning a generic retry', async () => {
  const read = checked();
  const checkpoint = await position();
  await activateThroughCoordinator();
  let revalidations = 0;
  const result = await completeCheckedRead(
    { coordinator, db: store.db },
    effects(read, checkpoint),
    async () => {
      revalidations++;
      return { status: 'reconstructed', effects: effects(checked(), await position()) };
    },
  );
  expect.soft(result.status).toBe('completed');
  expect.soft(revalidations).toBe(1);
});

it('does not hide an unreadable registry behind a stale publication checkpoint', async () => {
  const read = checked();
  const checkpoint = await position();
  await coordinator.publish(request);
  store.db
    .prepare('ALTER TABLE coverage_contract RENAME TO coverage_contract_unavailable_probe')
    .run();
  try {
    expect(
      await completeCheckedRead({ coordinator, db: store.db }, effects(read, checkpoint)),
    ).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_store_unavailable', bounds: {} },
    });
  } finally {
    store.db
      .prepare('ALTER TABLE coverage_contract_unavailable_probe RENAME TO coverage_contract')
      .run();
  }
});

it('does not commit a read whose reset callback returned a promise', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resetFinished: Promise<void> | undefined;
  const attempt: CheckedReadEffects<number> = {
    ...effects(checked(), await position()),
    // The misuse is the case. `resetDelivery` declares a void return and the lint rule is what
    // stops this reaching production; a caller that ignores it gets the behaviour asserted below,
    // so the boundary is proved rather than argued.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    resetDelivery: async (db) => {
      deleteServedItems(db, SESSION);
      resetFinished = held;
      await held;
    },
  };
  try {
    const outcome = await completeCheckedRead({ coordinator, db: store.db }, attempt).catch(
      (error: unknown) => error,
    );
    expect.soft(outcome).not.toMatchObject({ status: 'completed' });
    expect.soft(readServedItems(store.db, SESSION).size).toBe(1);
    expect.soft(persisted()).toBeUndefined();
  } finally {
    release();
    await resetFinished;
  }
});

it('does not hide registry failure behind a durable pending publication', async () => {
  const read = checked();
  const checkpoint = await position();
  failAt = 'prepared';
  await expect(coordinator.publish(request)).rejects.toThrow();
  store.db.prepare('ALTER TABLE coverage_contract RENAME TO coverage_contract_pending_probe').run();
  try {
    expect(
      await completeCheckedRead({ coordinator, db: store.db }, effects(read, checkpoint)),
    ).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_store_unavailable', bounds: {} },
    });
  } finally {
    store.db
      .prepare('ALTER TABLE coverage_contract_pending_probe RENAME TO coverage_contract')
      .run();
    await coordinator.recover();
  }
});

it('refuses an asynchronous persist result even when the result type is unknown', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempt: CheckedReadEffects<unknown> = {
    read: checked(),
    checkpoint: await position(),
    persist: async (db) => {
      markLedgerApplied(db, `async-persist:${serial}`, 1);
      await held;
      return 1;
    },
  };
  try {
    const outcome = await completeCheckedRead({ coordinator, db: store.db }, attempt).catch(
      (error: unknown) => error,
    );
    expect.soft(outcome).not.toMatchObject({ status: 'completed' });
    expect.soft(getLedgerEntry(store.db, `async-persist:${serial}`)).toBeUndefined();
  } finally {
    release();
    await held;
  }
});
