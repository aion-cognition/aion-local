import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  runCheckedRecall,
  type CheckedRecallDeps,
  type CheckedRecallOutcome,
} from './checked-recall.js';
import { CueCache } from './cues.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
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
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import {
  PublicationCoordinator,
  type PublicationRequest,
} from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getLastPack } from '../../infrastructure/sqlite/last-pack.js';
import { readServedItems, recordServedItems } from '../../infrastructure/sqlite/served-items.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The completion race at the entry point, against the real coordinator and its two stores.
 *
 * The unit battery drives the same decisions over a stubbed boundary; what only a real
 * coordinator can show is a coverage activation that moves the graph receipt and the epoch
 * together, which is the change a checked read is most likely to lose to.
 *
 * Nothing here calls a model: the provider fails any generation and counts every call.
 */

const NOW = new Date('2026-09-08T12:00:00.000Z');
const ACTIVATED_AT = new Date('2026-09-08T02:00:00.000Z');
const IDENTITY = 'checked-recall-int';
const logger: Logger = openLogger({ filePath: '/dev/null', level: 'error' });

let dir: string;
let substrate: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let request: PublicationRequest;
let failAt: PublicationBoundary | undefined;
let serial = 0;
let generateCalls = 0;
let embedCalls = 0;
/** Runs inside the embed call, which is mid-read: after the coverage check, before completion. */
let midRead: (() => Promise<void>) | undefined;

const provider = {
  embed: async (texts: readonly string[]) => {
    embedCalls += 1;
    const pending = midRead;
    midRead = undefined;
    await pending?.();
    return texts.map(() => [1, 0, 0]);
  },
  generate: () => {
    generateCalls += 1;
    return Promise.reject(new Error('a covered recall test never spends a generation'));
  },
} as unknown as Provider;

function deps(): CheckedRecallDeps {
  const { driver } = substrate.harness;
  return {
    driver,
    db: store.db,
    sessions: new SessionManager(driver, { memberId: 'member-1', workspaceId: 'workspace-global' }),
    provider,
    config: DEFAULTS,
    cueCache: new CueCache(),
    logger,
    resolver: new EvidenceResolver({ driver, db: store.db, logger }),
    coordinator,
  };
}

function recall(payload: Record<string, unknown> = {}): Promise<CheckedRecallOutcome> {
  return runCheckedRecall(
    deps(),
    { query: 'why webhooks', ...payload },
    { identity: IDENTITY, now: NOW },
  );
}

/** The real activation: one publication that moves the graph receipt and the epoch together. */
async function activateThroughCoordinator(): Promise<void> {
  store.db.prepare('UPDATE publication_control SET activation_capability_revision = 1').run();
  await coordinator.publish({
    kind: 'coverage_activation',
    operationId: `activation-${String(serial)}`,
    payload: {
      expectedEpoch: readCurrentCoverageContract(store.db)?.epoch,
      capabilityRevision: 1,
      fieldPolicyVersion: 1,
    },
  });
}

/** Reversibly: the fixture puts the substrate back the way it found it. */
function hideRegistry(): void {
  store.db.prepare('ALTER TABLE coverage_contract RENAME TO coverage_contract_hidden').run();
}

function restoreRegistry(): void {
  store.db.prepare('ALTER TABLE coverage_contract_hidden RENAME TO coverage_contract').run();
}

function holdings(): readonly string[] {
  return [...readServedItems(store.db, IDENTITY).keys()];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-checked-recall-int-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [new ProbePublication(), ...PUBLICATION_HANDLERS],
    now: () => ACTIVATED_AT,
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted publication');
      }
    },
  });
  await coordinator.initialize();
  await activateThroughCoordinator();
}, 90_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  failAt = undefined;
  midRead = undefined;
  generateCalls = 0;
  embedCalls = 0;
  serial += 1;
  const nodeId = `checked-recall-${String(serial)}`;
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  const payload: ProbePayload = { nodeId, value: 'published', expectedVersion: 0, expectedScope };
  request = { kind: 'semantic_write', operationId: `operation-${String(serial)}`, payload };
  store.db.prepare('DELETE FROM served_items WHERE session_id = ?').run(IDENTITY);
  recordServedItems(store.db, IDENTITY, [{ itemId: 'held', fingerprint: 'f' }], NOW.toISOString());
  store.db.prepare('DELETE FROM last_pack WHERE session_id = ?').run(IDENTITY);
});

describe('a checked recall against both stores', () => {
  it('records its effects and its staged reset in one transaction', async () => {
    const outcome = await recall({ reset_delivery_suppression: true });

    expect(outcome).toMatchObject({ status: 'pack', effects: 'persisted' });
    expect(getLastPack(store.db, IDENTITY)).toBeDefined();
    expect(holdings()).toEqual([]);
  });

  it('refuses a request before the horizon without reading either store', async () => {
    const outcome = await recall({
      knew_at: '2026-01-01T00:00:00.000Z',
      reset_delivery_suppression: true,
    });

    expect(outcome).toMatchObject({
      status: 'coverage_refusal',
      refusal: {
        reason: 'before_horizon',
        bounds: { coverage_state: 'active', history_since: ACTIVATED_AT.toISOString() },
      },
    });
    expect([generateCalls, embedCalls]).toEqual([0, 0]);
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
    expect(holdings()).toEqual(['held']);
  });
});

describe('when the contract moves while the read is in flight', () => {
  it('refuses a real activation that lands mid-read and keeps the holdings', async () => {
    midRead = activateThroughCoordinator;

    const outcome = await recall({ reset_delivery_suppression: true });

    expect(outcome).toMatchObject({
      status: 'coverage_refusal',
      refusal: { reason: 'coverage_changed', bounds: { coverage_state: 'active' } },
    });
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
    expect(holdings()).toEqual(['held']);
    // The work spent before the contract moved stays spent, and the refusal never says otherwise.
    expect(embedCalls).toBeGreaterThan(0);
  });

  it('refuses rather than degrading when the registry stops being readable mid-read', async () => {
    midRead = () => {
      hideRegistry();
      return Promise.resolve();
    };

    try {
      expect(await recall()).toMatchObject({
        status: 'coverage_refusal',
        refusal: { reason: 'coverage_store_unavailable', bounds: {} },
      });
    } finally {
      restoreRegistry();
    }
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
  });
});

describe('when the publication boundary will not take the effects', () => {
  it('serves the answer and records nothing behind a position that moved', async () => {
    midRead = async () => {
      expect(await coordinator.publish(request)).toMatchObject({ status: 'acknowledged' });
    };

    const outcome = await recall({ reset_delivery_suppression: true });

    expect(outcome).toMatchObject({ status: 'pack', effects: 'withheld' });
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
    expect(holdings()).toEqual(['held']);
  });

  it('degrades against a durable pending publication and discloses it', async () => {
    failAt = 'prepared';
    await expect(coordinator.publish(request)).rejects.toThrow();

    try {
      const outcome = await recall();

      expect(outcome).toMatchObject({
        status: 'pack',
        effects: 'withheld',
        pack: {
          metadata: {
            history_coverage: {
              gaps: [{ field: 'interpretation_text', reason: 'pending_publication' }],
            },
          },
        },
      });
      expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
      expect(holdings()).toEqual(['held']);
    } finally {
      await coordinator.recover();
    }
  }, 30_000);
});
