import { afterEach, expect, it } from 'vitest';

import { endpointCensusScopes } from './legacy-records.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { prepareScopeAdvance } from '../../infrastructure/sqlite/evidence-scope.js';

const store = new SqliteStore({ filePath: ':memory:' });
afterEach(() => {
  store.close();
});
it('does not adopt a pre-existing uncounted citation scope it did not enumerate', () => {
  prepareScopeAdvance(store.db, {
    endpointId: 'node',
    relationClass: 'sqlite.revision_citations',
    operationId: 'pending-citation',
    updatedAt: new Date(),
  });
  expect(endpointCensusScopes(store.db, 'node')).not.toContain('sqlite.revision_citations');
});
