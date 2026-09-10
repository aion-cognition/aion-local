import type { Driver } from 'neo4j-driver';
import { afterEach, expect, it, vi } from 'vitest';

import { sealChunk } from './chunk-manifest.js';
import { prepareCoverageContract } from './coverage-contract.js';
import { SqliteStore } from './database.js';
import {
  allocateNarrativeRevision,
  blockRevisionAttempt,
  CHUNK_REVISION_FAMILY,
  publishNarrativeRevision,
  readNarrativeRevision,
} from './narrative-revisions.js';
import { getLedgerEntry } from './ops-ledger.js';
import { recordSourceRecord } from './source-identity.js';
import { establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { reconsiderBlockedAttempts } from '../../introspection/application/operations/seal-reconsider.js';
import type { OperationContext } from '../../introspection/domain/operation.js';
import { healthFixture } from '../../introspection/domain/test-support/health.fixture.js';
import { narrativeFamilyRepairPublication } from '../../reflection/application/narrative-repair.js';
import { DEFAULTS } from '../config/defaults.js';
import type { GraphTransaction } from '../graph/connection.js';
import { openLogger } from '../logging/logger.js';
import { buildEvidenceRevision } from '../publication/preconditions.js';

const NOW = new Date('2026-09-09T06:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

function chunk(store: SqliteStore, id: string): string {
  recordSourceRecord(store.db, {
    sourceId: id,
    sessionId: id,
    verificationStatus: 'pinned',
    verificationReason: 'membership-only fixture',
    occurredAt: NOW.toISOString(),
    createdAt: NOW,
  });
  return sealChunk(store.db, { sessionId: id, sourceIds: [id], sealedAt: NOW }).chunkId;
}

it('keeps guarded candidate enumeration bounded even when almost all old revisions are closed', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  prepareCoverageContract(store.db, 1);
  try {
    const family = chunk(store, 'long-family');
    const nodes: string[] = [];
    for (let index = 0; index < 514; index += 1) {
      const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, family, NOW);
      nodes.push(allocation.nodeId);
      publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
        familyKey: family,
        revisionNo: allocation.revisionNo,
        operationId: `history:${String(index)}`,
        evidenceRevisionJson: JSON.stringify(buildEvidenceRevision([])),
        knownFrom: NOW.toISOString(),
        observedAckAt: NOW.toISOString(),
        publishedAt: NOW,
        coverageGapsJson: '[]',
      });
    }
    const standing = new Set(nodes.slice(-2));
    let candidatesRead = 0;
    let pageReads = 0;
    const graph = {
      run: vi.fn(async (_text: string, parameters: { nodeId?: string; nodeIds?: string[] }) => {
        if (parameters.nodeIds !== undefined) {
          candidatesRead += parameters.nodeIds.length;
          pageReads += 1;
          return parameters.nodeIds.filter((id) => standing.has(id));
        }
        return parameters.nodeId !== undefined && standing.has(parameters.nodeId)
          ? [parameters.nodeId]
          : [];
      }),
    } as unknown as GraphTransaction;
    const plan = await narrativeFamilyRepairPublication.prepare(
      { db: store.db, graph, operationId: 'repair-history', sequence: null, now: NOW },
      { chunkId: family, coverageEpoch: 'fixture-epoch', observedAt: NOW.toISOString() },
    );
    expect(pageReads).toBeGreaterThan(0);
    // The surrounding cleanup run declares a 200-record scan budget. Pages do not renew it.
    expect.soft(candidatesRead).toBeLessThanOrEqual(200);
    const { targets } = plan.data as { targets: string[] };
    expect(targets.every((id) => standing.has(id) && id !== nodes.at(-1))).toBe(true);
    // Keep the measured witness in output without inferring latency from a mocked graph.
    console.log({ candidatesRead, pageReads, standing: standing.size });
  } finally {
    store.close();
  }
});

it('continues the bounded reconsideration scan past 256 unchanged blocks across runs', () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  try {
    const rows: { chunkId: string; revisionNo: number; scopeId: string }[] = [];
    for (let index = 0; index < 300; index += 1) {
      const id = `blocked-history:${String(index)}`;
      const family = chunk(store, id);
      const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, family, NOW);
      blockRevisionAttempt(
        store.db,
        CHUNK_REVISION_FAMILY,
        family,
        allocation.revisionNo,
        'member_scope_census_missing',
        {
          at: NOW.toISOString(),
          suppressedMembers: [],
          uncountedScopes: [{ sourceId: id, scope: 'sqlite:stated_correction:in' }],
        },
      );
      rows.push({ chunkId: family, revisionNo: allocation.revisionNo, scopeId: id });
    }
    const target = rows.sort((a, b) => a.chunkId.localeCompare(b.chunkId)).at(-1)!;
    establishScope(store.db, target.scopeId, 'sqlite:stated_correction:in', NOW);
    const ctx = {
      db: store.db,
      driver: {} as Driver,
      now: NOW,
      config: DEFAULTS,
      logger: openLogger({ filePath: '/dev/null', level: 'fatal' }),
      provider: {
        generate: async () => {
          throw new Error('no generation');
        },
        embed: async () => {
          throw new Error('no embedding');
        },
      },
      health: healthFixture(),
      signal: new AbortController().signal,
    } as OperationContext;
    const inForce = { renderedInputAllowance: 16384, maxMembers: 64 };
    expect(reconsiderBlockedAttempts(ctx, 1, inForce)).toBe(0);
    expect(getLedgerEntry(store.db, 'narrative_seal:blocked_cursor')).toBeDefined();
    expect(reconsiderBlockedAttempts(ctx, 1, inForce)).toBe(1);
    expect(
      readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, target.chunkId, target.revisionNo)
        ?.blockedReason,
    ).toBeNull();
    expect(
      rows.filter(
        (row) =>
          readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, row.chunkId, row.revisionNo)
            ?.blockedReason === null,
      ),
    ).toHaveLength(1);
  } finally {
    store.close();
  }
});
