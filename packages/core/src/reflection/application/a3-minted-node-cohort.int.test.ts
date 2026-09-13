import { expect, it } from 'vitest';

import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import {
  acceptSource,
  acceptTurn,
  chunks,
  driver,
  NOW,
  store,
} from './test-support/t10b-review.fixture.js';
import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import { ownershipCensusEstablished } from '../../evidence/application/ownership.js';
import { readSourcePartTurnIds } from '../../infrastructure/sqlite/source-identity.js';

/**
 * The minted-node census against the other producer of an established census, over the two
 * cohorts that can exist at once.
 *
 * One cohort cannot reach a freshly minted id: it froze its membership at an earlier watermark
 * and carries no link row naming one. A second cohort id can, because a new one freezes at the
 * CURRENT watermark, and `aion consolidate` takes any id an operator types. That is the case
 * worth pinning: what the walk does to an endpoint this acceptance already counted.
 */

function deps() {
  return { driver, db: store.db, publications: chunks.publications };
}

async function walkAndSeal(cohortId: string): Promise<void> {
  await freezeLegacyCohort(deps(), { cohortId, now: NOW });
  const walked = await runLegacyBackfillBatch(deps(), { cohortId, now: NOW });
  expect(walked.pinned).toBe(0);
  expect(walked.remaining).toBe(0);
  const sealed = await sealLegacyCohortCensus(deps(), { cohortId });
  expect(sealed.deferred).toBeUndefined();
}

it('keeps a minted endpoint counted when a second cohort walks it', async () => {
  await acceptSource('cohort-a-member', 'the source the first cohort walked', false);
  await walkAndSeal('minted-cohort-a');

  const mintedId = await acceptTurn(
    'cohort-b-minted',
    'a capture after the first cohort froze',
    NOW,
  );
  const turnIds = readSourcePartTurnIds(store.db, mintedId);
  expect(turnIds).toHaveLength(1);
  for (const endpointId of [mintedId, ...turnIds]) {
    expect(ownershipCensusEstablished(store.db, endpointId)).toBe(true);
  }
  const [turnId = ''] = turnIds;
  // Three of seven, which is what leaves the repair lifecycle inert over a fresh turn.
  expect(certifyNodeSupport(store.db, turnId).support).toBe('unknown');

  // The second cohort freezes at the watermark this acceptance just moved, so the walk sweeps the
  // minted source in and the seal considers every scope its links place on both endpoints.
  await walkAndSeal('minted-cohort-b');

  for (const endpointId of [mintedId, ...turnIds]) {
    expect(ownershipCensusEstablished(store.db, endpointId)).toBe(true);
  }
  // The standing footgun, pinned as what it is rather than as a thing this writer caused. The
  // seal counts all seven support roles over an endpoint it materialized, so a turn whose only
  // classified edge is its own ordering stops answering unknown and starts maturing toward
  // suppression. Retiring the seal is what closes it.
  expect(certifyNodeSupport(store.db, turnId).support).toBe('unsupported');
}, 180_000);
