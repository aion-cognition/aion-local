import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { sealChunk } from './chunk-manifest.js';
import { prepareCoverageContract } from './coverage-contract.js';
import { SqliteStore } from './database.js';
import { readBlockContext } from './narrative-blocks.js';
import {
  allocateNarrativeRevision,
  blockRevisionAttempt,
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
  publishNarrativeRevision,
} from './narrative-revisions.js';
import { getLedgerEntry } from './ops-ledger.js';
import { recordSourceRecord } from './source-identity.js';
import { readSealDemand } from '../../introspection/application/seal-census.js';
import { rollUpOverviews } from '../../reflection/application/overview-rollup.js';
import * as bodies from '../graph/narrative-rollup-queries.js';
import { openLogger } from '../logging/logger.js';
import type { PublicationCoordinator } from '../publication/coordinator.js';
import { buildEvidenceRevision } from '../publication/preconditions.js';

const NOW = new Date('2026-09-09T06:00:00.000Z');

it.each([CHUNK_REVISION_FAMILY, OVERVIEW_REVISION_FAMILY])(
  'preserves recorded block context and adds the nullable column on retrofit in $revisionTable',
  (family) => {
    const dir = mkdtempSync(join(tmpdir(), 'aion-block-schema-'));
    const filePath = join(dir, 'store.sqlite');
    let store = new SqliteStore({ filePath });
    const context = {
      at: NOW.toISOString(),
      uncountedScopes: [{ sourceId: 'external', scope: 'sqlite:stated_correction:in' }],
      suppressedMembers: ['suppressed'],
    };
    try {
      const row = allocateNarrativeRevision(store.db, family, 'family', NOW);
      blockRevisionAttempt(
        store.db,
        family,
        'family',
        row.revisionNo,
        'member_scope_census_missing',
        context,
      );
      store.close();
      store = new SqliteStore({ filePath });
      expect(readBlockContext(store.db, family, 'family', row.revisionNo)).toEqual(context);
      store.db.exec(
        `ALTER TABLE ${family.revisionTable} RENAME COLUMN blocked_context_json TO review_old_context`,
      );
      store.close();
      store = new SqliteStore({ filePath });
      expect(readBlockContext(store.db, family, 'family', row.revisionNo)).toBeUndefined();
      expect(
        store.db
          .prepare(`SELECT blocked_reason, review_old_context FROM ${family.revisionTable}`)
          .get(),
      ).toEqual({
        blocked_reason: 'member_scope_census_missing',
        review_old_context: JSON.stringify(context),
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('writes only the operational census cursor and reports a read-only store as unavailable', () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  const input = { now: NOW, batch: 1, maxSpanMs: 86400000, maxMembers: 64 };
  try {
    const changes = () =>
      (store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes();
    expect(readSealDemand(store.db, input).availability).toBe('measured');
    expect(changes() - before).toBe(1);
    expect(getLedgerEntry(store.db, 'narrative-seal:census-head-cursor')).toBeDefined();
    store.db.pragma('query_only = ON');
    const held = changes();
    expect(readSealDemand(store.db, input).availability).toBe('unavailable');
    expect(changes()).toBe(held);
  } finally {
    store.close();
  }
});

it('reports a window cut by the membership page instead of returning a zero-blocked no-op', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  prepareCoverageContract(store.db, 1);
  try {
    // This is a C1 membership fixture, not a source-evidence or publication acceptance test.
    store.db
      .transaction(() => {
        for (let index = 0; index < 501; index += 1) {
          const id = `window-source:${String(index)}`;
          recordSourceRecord(store.db, {
            sourceId: id,
            sessionId: id,
            verificationStatus: 'pinned',
            verificationReason: 'membership-only fixture; source evidence is outside this test',
            occurredAt: '2026-08-01T12:00:00.000Z',
            createdAt: NOW,
          });
          const { chunkId } = sealChunk(store.db, {
            sessionId: id,
            sourceIds: [id],
            sealedAt: NOW,
          });
          const allocation = allocateNarrativeRevision(
            store.db,
            CHUNK_REVISION_FAMILY,
            chunkId,
            NOW,
          );
          publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
            familyKey: chunkId,
            revisionNo: allocation.revisionNo,
            operationId: `fixture:${id}`,
            evidenceRevisionJson: JSON.stringify(buildEvidenceRevision([])),
            knownFrom: NOW.toISOString(),
            observedAckAt: NOW.toISOString(),
            publishedAt: NOW,
            coverageGapsJson: '[]',
          });
        }
      })
      .immediate();
    const emptyBodies = vi.spyOn(bodies, 'findNarrativeBodies').mockResolvedValue(new Map());
    const publish = vi.fn(async () => {
      throw new Error('no publication is allowed in this nomination test');
    });
    const provider = {
      generate: async () => {
        throw new Error('no generation');
      },
      embed: async () => {
        throw new Error('no embedding');
      },
    };
    try {
      const result = await rollUpOverviews(
        {
          db: store.db,
          driver: {} as Driver,
          provider,
          publications: { publish } as unknown as PublicationCoordinator,
          logger: openLogger({ filePath: '/dev/null', level: 'fatal' }),
        },
        { scope: 'day', now: NOW, windowLimit: 1, renderedInputAllowance: 32768 },
      );
      expect(result.blocked).toBeGreaterThan(0);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      emptyBodies.mockRestore();
    }
  } finally {
    store.close();
  }
});
