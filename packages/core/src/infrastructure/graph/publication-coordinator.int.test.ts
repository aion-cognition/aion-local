import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { runGraphMigrations } from './migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import {
  currentProbeScope,
  overwriteProbeVersion,
  ProbePublication,
  readPublicationProbe,
  readProbeMaterialization,
  renameGuardIdentity,
  seedPublicationProbe,
  type ProbePayload,
} from './test-support/publication-operation.fixture.js';
import { PublicationCoordinator, type PublicationRequest } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import type { PublicationBoundary } from '../publication/types.js';
import { readCurrentCoverageContract } from '../sqlite/coverage-contract.js';
import { SqliteStore } from '../sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../sqlite/ops-ledger.js';
import { coordinatorControl, publicationRecord } from '../sqlite/publication-coordinator-store.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const logger = { warn: () => undefined, error: () => undefined };
let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
const cleanup: { store?: SqliteStore } = {};
let coordinator: PublicationCoordinator;
let clock = NOW;
let failAt: PublicationBoundary | undefined;
let failAck = false;
let graphCalls = 0;
let serial = 0;
let payload: ProbePayload;
let request: PublicationRequest;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-publication-int-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  cleanup.store = store;
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [
      new ProbePublication({
        failAck: () => failAck,
        graphApplied: () => {
          graphCalls += 1;
        },
      }),
      ...PUBLICATION_HANDLERS,
    ],
    now: () => clock,
    boundary: ({ boundary }) => {
      expect(store.db.inTransaction).toBe(false);
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted publication');
      }
    },
  });
  await coordinator.initialize();
}, 300_000);

beforeEach(async () => {
  clock = NOW;
  failAt = undefined;
  failAck = false;
  graphCalls = 0;
  serial += 1;
  const nodeId = `node-${serial}`;
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  payload = { nodeId, value: 'published', expectedVersion: 0, expectedScope };
  request = { kind: 'semantic_write', operationId: `operation-${serial}`, payload };
});

afterEach(async () => {
  failAt = undefined;
  failAck = false;
  await coordinator.recover();
});

afterAll(async () => {
  cleanup.store?.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('publishes once and returns its recorded result on redelivery', async () => {
  const result = await coordinator.publish(request);
  expect(result.status).toBe('acknowledged');
  expect(await coordinator.publish(request)).toEqual(result);
  expect(graphCalls).toBe(1);
  expect(getLedgerEntry(store.db, `ack:${request.operationId}`)?.summary).toBe(1);
  expect(currentProbeScope(store.db, payload.nodeId)).not.toBe(payload.expectedScope);
  expect(coordinator.hasPending()).toBe(false);
  expect(await coordinator.checkpoint()).toMatchObject({ status: 'ready' });
});

it('refuses a changed payload under an existing operation identity', async () => {
  await coordinator.publish(request);
  await expect(
    coordinator.publish({ ...request, payload: { ...payload, value: 'different' } }),
  ).rejects.toMatchObject({ reason: 'operation_identity_reused' });
  expect((await readPublicationProbe(substrate.harness.driver, payload.nodeId))?.value).toBe(
    'published',
  );
});

it('returns an older receipt after another publisher overwrites the graph receipt', async () => {
  const first = await coordinator.publish(request);
  await coordinator.publish({
    ...request,
    operationId: `${request.operationId}-second`,
    payload: {
      ...payload,
      value: 'second',
      expectedVersion: 1,
      expectedScope: currentProbeScope(store.db, payload.nodeId),
    },
  });
  expect(await coordinator.publish(request)).toEqual(first);
  expect(graphCalls).toBe(2);
  expect((await readPublicationProbe(substrate.harness.driver, payload.nodeId))?.value).toBe(
    'second',
  );
});

it.each(['prepared', 'graph_result_saved'] as const)(
  'recovers saved actions after interruption at %s',
  async (boundary) => {
    failAt = boundary;
    await expect(coordinator.publish(request)).rejects.toThrow();
    expect(coordinator.hasPending()).toBe(true);
    expect((await readPublicationProbe(substrate.harness.driver, payload.nodeId))?.version).toBe(0);
    expect(currentProbeScope(store.db, payload.nodeId)).toBe(payload.expectedScope);
    expect(getLedgerEntry(store.db, `accepted:${request.operationId}`)).toBeDefined();
    const recovered = await coordinator.recover();
    expect(recovered?.status).toBe('acknowledged');
    expect((await readPublicationProbe(substrate.harness.driver, payload.nodeId))?.version).toBe(1);
    expect(getLedgerEntry(store.db, `ack:${request.operationId}`)?.summary).toBe(1);
  },
);

it('acknowledges a committed graph receipt without replaying its mutation', async () => {
  failAt = 'graph_committed';
  await expect(coordinator.publish(request)).rejects.toThrow();
  expect((await readPublicationProbe(substrate.harness.driver, payload.nodeId))?.version).toBe(1);
  expect(currentProbeScope(store.db, payload.nodeId)).toBe(payload.expectedScope);
  expect(await coordinator.checkpoint()).toEqual({
    status: 'unavailable',
    reason: 'pending_publication',
  });
  expect((await coordinator.recover())?.status).toBe('acknowledged');
  expect(graphCalls).toBe(1);
});

it('rolls back failed SQLite effects and retries them once from the committed receipt', async () => {
  failAck = true;
  await expect(coordinator.publish(request)).rejects.toThrow();
  expect(getLedgerEntry(store.db, `ack:${request.operationId}`)).toBeUndefined();
  expect(currentProbeScope(store.db, payload.nodeId)).toBe(payload.expectedScope);
  failAck = false;
  await coordinator.recover();
  expect(graphCalls).toBe(1);
  expect(getLedgerEntry(store.db, `ack:${request.operationId}`)?.summary).toBe(1);
});

it('uses the receipt after the native commit succeeds but its client promise rejects', async () => {
  const { driver } = substrate.harness;
  const session = driver.session.bind(driver);
  const observed: unknown[] = [];
  const spy = vi.spyOn(driver, 'session').mockImplementation((config) => {
    const opened = session(config);
    const begin = opened.beginTransaction.bind(opened);
    vi.spyOn(opened, 'beginTransaction').mockImplementation((options) => {
      const pending = begin(options);
      void pending
        .then((transaction) => {
          const commit = transaction.commit.bind(transaction);
          vi.spyOn(transaction, 'commit').mockImplementationOnce(async () => {
            await commit();
            throw new Error('commit response lost');
          });
        })
        .catch((err: unknown) => {
          observed.push(err);
        });
      return pending;
    });
    return opened;
  });
  try {
    await expect(coordinator.publish(request)).rejects.toMatchObject({
      reason: 'pending_recovery',
    });
  } finally {
    spy.mockRestore();
  }
  expect(observed).toEqual([]);
  expect((await readPublicationProbe(driver, payload.nodeId))?.version).toBe(1);
  expect(getLedgerEntry(store.db, `ack:${request.operationId}`)).toBeUndefined();
  expect((await coordinator.recover())?.status).toBe('acknowledged');
  expect(graphCalls).toBe(1);
});

it.each(['sqlite', 'graph'] as const)(
  'rejects a stale %s dependency independently',
  async (authority) => {
    await coordinator.publish(request);
    const changed = {
      ...payload,
      expectedVersion: authority === 'sqlite' ? 1 : 0,
      expectedScope:
        authority === 'graph' ? currentProbeScope(store.db, payload.nodeId) : payload.expectedScope,
    };
    expect(
      await coordinator.publish({
        ...request,
        operationId: `${request.operationId}-stale`,
        payload: changed,
      }),
    ).toMatchObject({ status: 'deferred', reason: 'evidence_changed' });
    expect(graphCalls).toBe(1);
  },
);

it('refuses entry from an enclosing SQLite transaction before touching the graph', async () => {
  store.db.exec('BEGIN IMMEDIATE');
  const attempted = coordinator.publish(request);
  store.db.exec('ROLLBACK');
  await expect(attempted).rejects.toMatchObject({ reason: 'enclosing_sqlite_transaction' });
  expect(publicationRecord(store.db, request.operationId)).toBeUndefined();
  expect(graphCalls).toBe(0);
});

it('defers stale generated output without mutating the checked graph', async () => {
  await overwriteProbeVersion(substrate.harness.driver, payload.nodeId, 2);
  const result = await coordinator.publish(request);
  expect(result).toMatchObject({ status: 'deferred', reason: 'evidence_changed' });
  expect(graphCalls).toBe(0);
  expect(coordinator.hasPending()).toBe(false);
  expect(await coordinator.publish(request)).toEqual(result);
});

it('preserves accepted input when recovery finds the prepared result stale', async () => {
  failAt = 'prepared';
  await expect(coordinator.publish(request)).rejects.toThrow();
  await overwriteProbeVersion(substrate.harness.driver, payload.nodeId, 2);
  expect(await coordinator.recover()).toMatchObject({
    status: 'deferred',
    reason: 'evidence_changed',
  });
  expect(getLedgerEntry(store.db, `accepted:${request.operationId}`)).toBeDefined();
  expect(currentProbeScope(store.db, payload.nodeId)).toBe(payload.expectedScope);
  expect(coordinator.hasPending()).toBe(false);
});

it('performs completion effects only while the checkpoint is still current', async () => {
  const before = await coordinator.checkpoint();
  expect(before.status).toBe('ready');
  if (before.status !== 'ready') {
    throw new Error('checkpoint unavailable');
  }
  const completed = await coordinator.completeRead(
    before.checkpoint,
    async (context) => {
      expect(context.db.inTransaction).toBe(false);
      return true;
    },
    (db) => {
      expect(db.inTransaction).toBe(true);
      markLedgerApplied(db, 'read-completed', 1);
      return 1;
    },
  );
  expect(completed).toEqual({ status: 'completed', value: 1 });
  await coordinator.publish(request);
  const stale = await coordinator.completeRead(
    before.checkpoint,
    async () => true,
    () => {
      throw new Error('a stale read must not persist effects');
    },
  );
  expect(stale).toMatchObject({ status: 'retry' });
});

it('keeps required graph materialization pending until a capable handler finishes it', async () => {
  let failFinish = true;
  const late = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [new ProbePublication({ finishGraph: true, failFinish: () => failFinish })],
    now: () => clock,
  });
  await late.initialize();
  try {
    await expect(late.publish(request)).rejects.toThrow();
    expect((await readPublicationProbe(substrate.harness.driver, payload.nodeId))?.version).toBe(1);
    expect(await readProbeMaterialization(substrate.harness.driver, payload.nodeId)).toBeNull();
    await expect(coordinator.recover()).rejects.toMatchObject({
      reason: 'graph_completion_handler_unavailable',
    });
    expect(getLedgerEntry(store.db, `ack:${request.operationId}`)).toBeUndefined();
  } finally {
    failFinish = false;
    await late.recover();
  }
  expect(await readProbeMaterialization(substrate.harness.driver, payload.nodeId)).toBe(
    request.operationId,
  );
  expect(getLedgerEntry(store.db, `ack:${request.operationId}`)?.summary).toBe(1);
});

it('clamps publication and activation clocks without waiting for the wall clock', async () => {
  await coordinator.publish(request);
  clock = new Date('2026-09-08T05:00:00.000Z');
  store.db.prepare('UPDATE publication_control SET activation_capability_revision = 1').run();
  const coverage = readCurrentCoverageContract(store.db);
  const activated = await coordinator.publish({
    kind: 'coverage_activation',
    operationId: 'activate-coverage',
    payload: { expectedEpoch: coverage?.epoch, capabilityRevision: 1, fieldPolicyVersion: 1 },
  });
  expect(activated).toMatchObject({
    status: 'acknowledged',
    knownFrom: NOW.toISOString(),
    observedAckAt: clock.toISOString(),
    clockClamped: true,
  });
  expect(readCurrentCoverageContract(store.db)).toMatchObject({
    state: 'active',
    historySince: NOW.toISOString(),
    activatedAt: NOW.toISOString(),
  });
});

it('refuses a missing guard without creating a replacement', async () => {
  const { substrateId } = coordinatorControl(store.db);
  await renameGuardIdentity(substrate.harness.driver, substrateId, 'foreign-pair');
  try {
    await expect(coordinator.publish(request)).rejects.toThrow();
    expect(publicationRecord(store.db, request.operationId)).toBeUndefined();
    expect(await coordinator.checkpoint()).toMatchObject({ status: 'unavailable' });
  } finally {
    await renameGuardIdentity(substrate.harness.driver, 'foreign-pair', substrateId);
  }
});

it('refuses an older SQLite snapshot when the graph has advanced beyond its pending intent', async () => {
  failAt = 'prepared';
  await expect(coordinator.publish(request)).rejects.toThrow();
  const backupPath = join(dir, 'older.sqlite');
  await store.db.backup(backupPath);
  await coordinator.recover();
  await coordinator.publish({
    ...request,
    operationId: `${request.operationId}-newer`,
    payload: {
      ...payload,
      value: 'newer',
      expectedVersion: 1,
      expectedScope: currentProbeScope(store.db, payload.nodeId),
    },
  });
  const older = new SqliteStore({ filePath: backupPath });
  try {
    const stale = new PublicationCoordinator({
      driver: substrate.harness.driver,
      db: older.db,
      logger,
      handlers: [new ProbePublication(), ...PUBLICATION_HANDLERS],
    });
    await expect(stale.initialize()).rejects.toMatchObject({
      reason: 'publication_pair_out_of_sync',
    });
    expect((await readPublicationProbe(substrate.harness.driver, payload.nodeId))?.value).toBe(
      'newer',
    );
  } finally {
    older.close();
  }
});

it('round-trips a publication sequence beyond the JavaScript safe integer range', async () => {
  store.db
    .prepare(
      "UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = 'publication_intents'",
    )
    .run('9007199254740992');
  const result = await coordinator.publish(request);
  expect(result.sequence).toBe('9007199254740993');
  const checkpoint = await coordinator.checkpoint();
  expect(checkpoint).toMatchObject({ status: 'ready', checkpoint: { sequence: result.sequence } });
  expect(await coordinator.publish(request)).toEqual(result);
});
