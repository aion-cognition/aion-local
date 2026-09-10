import { expect, it } from 'vitest';

import { certifyNarrativeSupport } from '../../../evidence/application/narrative-support.js';
import {
  establishNodeState,
  establishNodeSupportScopes,
} from '../../../evidence/test-support/evidence.fixture.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { readOrphanObservation } from '../../../infrastructure/sqlite/orphan-observations.js';
import {
  driver,
  NOW,
  store,
} from '../../../reflection/application/test-support/t10b-review.fixture.js';
import { readOrphanCensus } from '../orphan-census.js';

it('withholds an unbound legacy narrative while a proved ordinary orphan can mature', async () => {
  const old = new Date(NOW.getTime() - 40 * 86400000);
  const legacy = 'review-unbound-legacy-narrative';
  const claim = 'review-ordinary-unsupported-insight';
  await writeStampedNode(driver, {
    label: 'Narrative',
    id: legacy,
    now: old,
    properties: { text: 'the preserved legacy account', scope: 'session' },
  });
  await writeStampedNode(driver, {
    label: 'Insight',
    id: claim,
    now: old,
    properties: { text: 'a genuinely unsupported retained insight' },
  });
  for (const id of [legacy, claim]) {
    establishNodeSupportScopes(store.db, id, NOW);
    establishNodeState(store.db, id, { revision: 1, at: NOW });
  }
  expect(certifyNarrativeSupport(store.db, legacy).support).toBe('unbound');
  await readOrphanCensus(
    { driver, db: store.db },
    { limit: 10, now: NOW, forgetAfterDays: 30, policyRevision: 1 },
  );
  const later = new Date(NOW.getTime() + 31 * 86400000);
  const census = await readOrphanCensus(
    { driver, db: store.db },
    { limit: 10, now: later, forgetAfterDays: 30, policyRevision: 1 },
  );
  expect(census.entries.find((entry) => entry.nodeId === claim)?.decision.action).toBe('forget');
  expect.soft(readOrphanObservation(store.db, legacy)?.disposition).toBe('unknown');
  expect
    .soft(census.entries.find((entry) => entry.nodeId === legacy)?.decision.action)
    .not.toBe('forget');
});
