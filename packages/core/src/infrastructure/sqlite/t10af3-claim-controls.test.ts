import { expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { claimNarrativeRevision, releaseNarrativeClaim } from './narrative-allocations.js';
import {
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
  readNarrativeRevision,
} from './narrative-revisions.js';
import { preparePublicationIntent } from './publication-intents.js';

const NOW = new Date('2026-09-09T06:00:00.000Z');
const later = new Date(NOW.getTime() + 1000);

it.each([CHUNK_REVISION_FAMILY, OVERVIEW_REVISION_FAMILY])(
  'preserves intent-owned expiry and known-finished reuse in $revisionTable',
  (family) => {
    const store = new SqliteStore({ filePath: ':memory:' });
    try {
      const request = {
        familyKey: 'owned-family',
        operationPrefix: 'owned:',
        now: NOW,
        leaseUntil: later,
      };
      const first = claimNarrativeRevision(store.db, family, request);
      expect(
        releaseNarrativeClaim(store.db, family, {
          familyKey: request.familyKey,
          revisionNo: first.revisionNo,
          operationId: 'not-the-owner',
        }),
      ).toBe(false);
      expect(
        releaseNarrativeClaim(store.db, family, {
          familyKey: request.familyKey,
          revisionNo: first.revisionNo,
          operationId: 'owned:1',
        }),
      ).toBe(true);
      const resumed = claimNarrativeRevision(store.db, family, request);
      expect(resumed.revisionNo).toBe(first.revisionNo);
      preparePublicationIntent(store.db, {
        operationId: 'owned:1',
        kind: 'narrative_publish',
        payloadDigest: 'fixture',
        payloadJson: '{}',
        affectedScopesJson: '[]',
        expectedJson: '{}',
        preparedActionsJson: '[]',
        createdAt: NOW,
      });
      const next = claimNarrativeRevision(store.db, family, {
        ...request,
        now: new Date(later.getTime() + 1),
        leaseUntil: new Date(later.getTime() + 2000),
      });
      expect(next.revisionNo).toBe(2);
      expect(
        readNarrativeRevision(store.db, family, request.familyKey, first.revisionNo)?.state,
      ).toBe('allocated');
      expect(
        releaseNarrativeClaim(store.db, family, {
          familyKey: request.familyKey,
          revisionNo: first.revisionNo,
          operationId: 'owned:1',
        }),
      ).toBe(false);
      const expiryRequest = { ...request, familyKey: 'expired-family', operationPrefix: 'expiry:' };
      const expiring = claimNarrativeRevision(store.db, family, expiryRequest);
      const replacement = claimNarrativeRevision(store.db, family, {
        ...expiryRequest,
        now: new Date(later.getTime() + 1),
        leaseUntil: new Date(later.getTime() + 2000),
      });
      expect(replacement.revisionNo).toBeGreaterThan(expiring.revisionNo);
      expect(
        readNarrativeRevision(store.db, family, 'expired-family', expiring.revisionNo),
      ).toMatchObject({ state: 'abandoned', lastFailureReason: 'claim_expired' });
    } finally {
      store.close();
    }
  },
);
