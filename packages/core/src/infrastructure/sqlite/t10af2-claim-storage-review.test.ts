import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { claimNarrativeRevision, releaseNarrativeClaim } from './narrative-allocations.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
} from './narrative-revisions.js';

const NOW = new Date('2026-09-09T06:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_001);
const families = [CHUNK_REVISION_FAMILY, OVERVIEW_REVISION_FAMILY];

it.each(families)('adds and preserves lease columns on reopen for $revisionTable', (family) => {
  const dir = mkdtempSync(join(tmpdir(), 'aion-lease-schema-review-'));
  const path = join(dir, 'store.sqlite');
  let store = new SqliteStore({ filePath: path });
  try {
    const first = allocateNarrativeRevision(store.db, family, 'schema-family', NOW);
    expect(first.revisionNo).toBe(1);
    const names = store.db.prepare(`PRAGMA table_info(${family.revisionTable})`).all() as {
      name: string;
    }[];
    expect(names.some((row) => row.name === 'claim_expires_at')).toBe(true);
    store.db.exec(
      `ALTER TABLE ${family.revisionTable} RENAME COLUMN claim_expires_at TO review_old_claim`,
    );
    store.close();
    store = new SqliteStore({ filePath: path });
    const row = store.db
      .prepare(`SELECT revision_no, state, claim_expires_at FROM ${family.revisionTable}`)
      .get();
    expect(row).toEqual({ revision_no: 1, state: 'allocated', claim_expires_at: null });
    const lease = new Date(NOW.getTime() + 60_000);
    const claim = claimNarrativeRevision(store.db, family, {
      familyKey: 'schema-family',
      operationPrefix: 'schema:',
      now: NOW,
      leaseUntil: lease,
    });
    expect(claim.revisionNo).toBe(1);
    expect(
      store.db
        .prepare(`SELECT claim_expires_at, next_attempt_at FROM ${family.revisionTable}`)
        .get(),
    ).toEqual({
      claim_expires_at: lease.toISOString(),
      next_attempt_at: null,
    });
    store.close();
    store = new SqliteStore({ filePath: path });
    expect(store.db.prepare(`SELECT claim_expires_at FROM ${family.revisionTable}`).get()).toEqual({
      claim_expires_at: lease.toISOString(),
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(families)(
  'does not let an old actor release a reclaimed lease in $revisionTable',
  (family) => {
    const dir = mkdtempSync(join(tmpdir(), 'aion-claim-actor-review-'));
    const path = join(dir, 'store.sqlite');
    const firstStore = new SqliteStore({ filePath: path });
    const secondStore = new SqliteStore({ filePath: path });
    const request = {
      familyKey: 'actor-family',
      operationPrefix: 'actor:',
      now: NOW,
      leaseUntil: new Date(NOW.getTime() + 60_000),
    };
    try {
      const old = claimNarrativeRevision(firstStore.db, family, request);
      const next = claimNarrativeRevision(secondStore.db, family, {
        ...request,
        now: LATER,
        leaseUntil: new Date(LATER.getTime() + 60_000),
      });
      const newer = secondStore.db
        .prepare(
          `SELECT operation_id, claim_expires_at FROM ${
            family.revisionTable
          } WHERE revision_no = ?`,
        )
        .get(next.revisionNo);
      releaseNarrativeClaim(firstStore.db, family, {
        familyKey: request.familyKey,
        revisionNo: old.revisionNo,
        operationId: request.operationPrefix + String(old.revisionNo),
      });
      expect(
        secondStore.db
          .prepare(
            `SELECT operation_id, claim_expires_at FROM ${
              family.revisionTable
            } WHERE revision_no = ?`,
          )
          .get(next.revisionNo),
      ).toEqual(newer);
    } finally {
      secondStore.close();
      firstStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each(families)(
  'control: two actors claim distinct unexpired numbers in $revisionTable',
  (family) => {
    const dir = mkdtempSync(join(tmpdir(), 'aion-distinct-claim-review-'));
    const path = join(dir, 'store.sqlite');
    const firstStore = new SqliteStore({ filePath: path });
    const secondStore = new SqliteStore({ filePath: path });
    const request = {
      familyKey: 'distinct-family',
      operationPrefix: 'distinct:',
      now: NOW,
      leaseUntil: LATER,
    };
    try {
      const first = claimNarrativeRevision(firstStore.db, family, request);
      const second = claimNarrativeRevision(secondStore.db, family, request);
      expect(second.revisionNo).not.toBe(first.revisionNo);
    } finally {
      secondStore.close();
      firstStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
