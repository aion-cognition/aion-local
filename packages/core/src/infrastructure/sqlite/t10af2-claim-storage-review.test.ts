import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { claimNarrativeRevision, releaseNarrativeClaim } from './narrative-allocations.js';
import { CHUNK_REVISION_FAMILY, OVERVIEW_REVISION_FAMILY } from './narrative-revisions.js';

const NOW = new Date('2026-09-09T06:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_001);
const families = [CHUNK_REVISION_FAMILY, OVERVIEW_REVISION_FAMILY];

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
