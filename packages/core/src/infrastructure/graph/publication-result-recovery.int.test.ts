import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import { runGraphMigrations } from './migrations.js';
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
import { PublicationOperation } from '../publication/operation.js';
import { buildEvidenceRevision } from '../publication/preconditions.js';
import { PublicationRecoveryLoop } from '../publication/recovery.js';
import type { PublicationBoundary, PublicationCheck } from '../publication/types.js';
import { readCurrentCoverageContract } from '../sqlite/coverage-contract.js';
import { SqliteStore } from '../sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../sqlite/ops-ledger.js';
import { publicationRecord } from '../sqlite/publication-coordinator-store.js';

const logger = { warn: () => undefined, error: () => undefined };
const NOW = new Date('2026-09-08T06:00:00.000Z');

const Payload = z.strictObject({ id: z.string().min(1) });
const Result = z.strictObject({ id: z.string(), sidecars: z.number().int() });

let applies = 0;
const observedResults: number[] = [];

/** Shaped like `intake`: the write is fenced, the returned summary is not. */
class IntakeShapedPublication extends PublicationOperation<
  z.infer<typeof Payload>,
  z.infer<typeof Payload>,
  z.infer<typeof Result>
> {
  constructor() {
    super({
      kind: 'intake',
      effectKinds: ['intake_ack'],
      payload: Payload,
      data: Payload,
      result: Result,
      prepare(context, data) {
        const coverage = readCurrentCoverageContract(context.db);
        if (coverage === undefined) {
          throw new Error('fixture coverage is absent');
        }
        return Promise.resolve({
          data,
          expected: {
            coverageEpoch: coverage.epoch,
            evidence: buildEvidenceRevision([]),
            sources: [],
            heads: [],
          },
          scopes: [],
          effects: [{ kind: 'intake_ack', detail: {} }],
        });
      },
      // Revalidates the declared preconditions. The sidecar count is not one of them.
      check(): Promise<PublicationCheck> {
        return Promise.resolve({ status: 'valid' });
      },
      async applyGraph(context, data) {
        applies += 1;
        const rows = await context.graph.run(
          `MERGE (n:IntakeProbe {id: $id})
           WITH n MATCH (s:Sidecar)
           WITH n, count(s) AS sidecars
           SET n.sidecars = sidecars
           RETURN n.id AS id, sidecars AS sidecars`,
          { id: data.id },
          (row) => Result.parse(row),
        );
        if (rows[0] === undefined) {
          throw new Error('intake probe produced no row');
        }
        observedResults.push(rows[0].sidecars);
        return rows[0];
      },
      prepareSqlite(context) {
        markLedgerApplied(context.db, `accepted:${context.operationId}`, 1);
        return undefined;
      },
      acknowledgeSqlite(context) {
        markLedgerApplied(context.db, `ack:${context.operationId}`, 1);
        return undefined;
      },
      discardSqlite() {
        return undefined;
      },
    });
  }
}

let dir: string;
let substrate: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let failAt: PublicationBoundary | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-adv-nondet-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [new IntakeShapedPublication(), new ProbePublication(), ...PUBLICATION_HANDLERS],
    now: () => NOW,
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted publication');
      }
    },
  });
  await coordinator.initialize();
  await substrate.harness.driver.executeQuery('CREATE (:Sidecar {id: "seed"})');
}, 180_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('recovers when undeclared graph state moved between the journal and the replay', async () => {
  const operationId = 'intake-nondet';
  failAt = 'graph_result_saved';
  await expect(
    coordinator.publish({ kind: 'intake', operationId, payload: { id: operationId } }),
  ).rejects.toThrow();

  // The graph transaction rolled back; the journal kept the rolled-back attempt's output.
  const present = await substrate.harness.driver.executeQuery(
    'MATCH (n:IntakeProbe {id: $id}) RETURN count(n) AS present',
    { id: operationId },
  );
  expect(Number(present.records[0]?.get('present') ?? -1)).toBe(0);
  expect(publicationRecord(store.db, operationId)?.resultJson).toBe(
    JSON.stringify({ id: operationId, sidecars: 1 }),
  );
  expect(coordinator.hasPending()).toBe(true);

  // An unrelated writer touches state the plan never fenced. `check()` still passes.
  await substrate.harness.driver.executeQuery('CREATE (:Sidecar {id: "concurrent"})');

  const recovered = await coordinator.recover();
  expect(recovered?.status).toBe('acknowledged');
  expect(getLedgerEntry(store.db, `ack:${operationId}`)).toBeDefined();
  expect(coordinator.hasPending()).toBe(false);
  expect(applies).toBe(2);
  expect(observedResults).toEqual([1, 2]);
});

it('does not strand the single pending slot for every later publication', async () => {
  // Blast radius: a stuck slot is a substrate-wide write outage, not one lost operation.
  const nodeId = 'after-nondet';
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  await expect(
    coordinator.publish({
      kind: 'semantic_write',
      operationId: 'after-nondet',
      payload: { nodeId, value: 'after', expectedVersion: 0, expectedScope },
    }),
  ).resolves.toMatchObject({ status: 'acknowledged' });
});

it('keeps the read barrier usable', async () => {
  expect(await coordinator.checkpoint()).toMatchObject({ status: 'ready' });
});

it('lets the shared recovery loop clear the slot rather than warn forever', async () => {
  const warnings: unknown[] = [];
  const loop = new PublicationRecoveryLoop(
    coordinator,
    {
      warn: (payload: unknown) => {
        warnings.push(payload);
      },
    },
    { retryBaseMs: 20, retryCapMs: 40 },
  );
  loop.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 400);
  });
  await loop.stop();
  expect(coordinator.hasPending()).toBe(false);
  expect(warnings).toEqual([]);
});
