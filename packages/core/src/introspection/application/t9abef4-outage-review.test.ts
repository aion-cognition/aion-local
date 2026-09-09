import type { Driver } from 'neo4j-driver';
import { expect, it, vi } from 'vitest';

import { readOrphanCensus } from './orphan-census.js';
import {
  establishNodeState,
  establishNodeSupportScopes,
} from '../../evidence/test-support/evidence.fixture.js';
import * as topology from '../../infrastructure/graph/topology-queries.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readOrphanObservation } from '../../infrastructure/sqlite/orphan-observations.js';

it('breaks the qualification interval when its association history read is unavailable', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  const first = new Date('2026-05-01T00:00:00.000Z');
  const failed = new Date('2026-05-02T00:00:00.000Z');
  const recovered = new Date('2026-07-01T00:00:00.000Z');
  const driver = {} as Driver;
  vi.spyOn(topology, 'findOrphanNodes').mockResolvedValue([{ id: 'node', txFrom: first }]);
  vi.spyOn(topology, 'findOrphanRelinkTargets').mockResolvedValue([]);
  const history = vi
    .spyOn(topology, 'nodeAssociationHistory')
    .mockResolvedValue(new Map([['node', topology.NO_ASSOCIATION_HISTORY]]));
  establishNodeSupportScopes(store.db, 'node', first);
  establishNodeState(store.db, 'node', { revision: 1, at: first });
  try {
    await readOrphanCensus(
      { driver, db: store.db },
      { limit: 10, now: first, forgetAfterDays: 30, policyRevision: 0 },
    );
    expect(readOrphanObservation(store.db, 'node')?.disposition).toBe('unsupported');
    history.mockRejectedValueOnce(new Error('temporary graph history read failure'));
    await readOrphanCensus(
      { driver, db: store.db },
      { limit: 10, now: failed, forgetAfterDays: 30, policyRevision: 0 },
    ).catch(() => undefined);
    expect.soft(readOrphanObservation(store.db, 'node')?.disposition).not.toBe('unsupported');
    await readOrphanCensus(
      { driver, db: store.db },
      { limit: 10, now: recovered, forgetAfterDays: 30, policyRevision: 0 },
    );
    expect(readOrphanObservation(store.db, 'node')?.firstVerifiedAt).toBe(recovered.toISOString());
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});
