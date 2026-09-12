import { expect, it } from 'vitest';

import { INCOMING_STATEMENT_SCOPES } from './chunk-evidence.js';
import { intakePublication } from './intake-publication.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { PUBLICATION_KINDS } from '../../infrastructure/publication/types.js';
import { prepareCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

it('declares the incoming scopes the new source producer actually mutates', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  const now = new Date('2026-09-10T12:00:00.000Z');
  prepareCoverageContract(store.db, 1);
  try {
    const plan = await intakePublication.prepare(
      {
        db: store.db,
        graph: {} as GraphTransaction,
        operationId: 'scope-audit',
        sequence: null,
        now,
        installedKinds: [...PUBLICATION_KINDS],
      },
      {
        identity: 'member',
        sessionId: 'session',
        payloadJson: JSON.stringify({ observations: ['a new source'] }),
        referencesJson: null,
        lane: null,
        originJson: null,
        pipelineVersion: 'fixture',
        occurredAt: now.toISOString(),
        indexPolicy: 'fixture',
        readiness: null,
      },
    );
    const data = intakePublication.decodeData(plan.data);
    expect(data.decision).toBe('new');
    expect(plan.scopes).toEqual(
      expect.arrayContaining(
        INCOMING_STATEMENT_SCOPES.map((scope) => ({
          kind: 'relation_scope',
          id: data.sourceId,
          scope,
        })),
      ),
    );
  } finally {
    store.close();
  }
});
