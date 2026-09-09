import { expect, it } from 'vitest';

import { claimMergePublication } from './merge-publication.js';
import {
  sourceStateDependency,
  verifyEvidenceRevision,
} from '../../evidence/application/dependencies.js';
import { seedSource, commitSourceState } from '../../evidence/test-support/evidence.fixture.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationContext } from '../../infrastructure/publication/types.js';
import {
  prepareCoverageContract,
  readCurrentCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

it('rejects an explicitly supplied merge evidence revision after its source changes', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  const now = new Date('2026-09-09T00:00:00.000Z');
  try {
    prepareCoverageContract(store.db, 1);
    seedSource(store.db, {
      sourceId: 'source',
      sessionId: 'session',
      identity: 'review',
      content: { observations: ['evidence'] },
      now,
    });
    const context: PublicationContext = {
      operationId: 'merge',
      sequence: '1',
      db: store.db,
      graph: {} as GraphTransaction,
      now,
    };
    // The binding travels in the payload: the guard re-verifies what the judge decided on, and a
    // merge that carries none is refused before any of this.
    const revision = buildEvidenceRevision([sourceStateDependency(store.db, 'source')]);
    const plan = await claimMergePublication.prepare(context, {
      survivorId: 'survivor',
      loserId: 'loser',
      now: now.toISOString(),
      judged: revision,
      coverageEpoch: readCurrentCoverageContract(store.db)?.epoch,
    });
    expect((await claimMergePublication.check(context, plan)).status).toBe('valid');
    commitSourceState(store.db, {
      sourceId: 'source',
      stateKind: 'forgotten',
      operationId: 'forget',
      at: now,
    });
    expect(verifyEvidenceRevision(store.db, revision).status).toBe('stale');
    expect((await claimMergePublication.check(context, plan)).status).not.toBe('valid');
  } finally {
    store.close();
  }
});
