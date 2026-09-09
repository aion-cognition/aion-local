import type { Driver } from 'neo4j-driver';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { runSourceIndexJob } from './source-index.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { seedSource, commitSourceState } from '../../evidence/test-support/evidence.fixture.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { servedReferenceOutcome } from '../../infrastructure/sqlite/probe-incidence.js';
import { searchIndexPin } from '../../infrastructure/sqlite/source-search-store.js';
import {
  prepareMaterialization,
  acknowledgeMaterialization,
  type MaterializationWrite,
} from '../../reflection/application/legacy-records.js';

const OLD = new Date('2026-09-01T00:00:00.000Z');
const SERVED = '2026-09-04T00:00:00.000Z';
const LATE = '2026-09-05T00:00:00.000Z';
const NOW = new Date('2026-09-08T00:00:00.000Z');
let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: OLD, fieldPolicyVersion: 1 });
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { observations: ['needle in the archive'] },
    now: OLD,
  });
});
afterEach(() => {
  store.close();
});

const REFERENCE_CASES: {
  name: string;
  clocks: Readonly<Record<string, string>>;
  expected: string;
}[] = [
  {
    name: 'future world date, earlier acceptance',
    clocks: { valid_from: LATE, tx_from: OLD.toISOString() },
    expected: 'none',
  },
  {
    name: 'earlier world date, later acceptance',
    clocks: { valid_from: OLD.toISOString(), tx_from: LATE },
    expected: 'referenced_after',
  },
  {
    name: 'world date without acceptance proof',
    clocks: { valid_from: LATE },
    expected: 'unversioned',
  },
  { name: 'invalid acceptance clock', clocks: { tx_from: 'not-a-date' }, expected: 'unversioned' },
  { name: 'earlier acceptance control', clocks: { tx_from: OLD.toISOString() }, expected: 'none' },
  { name: 'later acceptance control', clocks: { tx_from: LATE }, expected: 'referenced_after' },
];

it.each(REFERENCE_CASES)('uses the accepted-reference clock: $name', ({ clocks, expected }) => {
  const write: MaterializationWrite = {
    sourceId: 'source',
    operationId: 'materialize',
    scopes: [],
    observedAt: NOW,
    links: [
      {
        linkId: 'mention',
        kind: 'mention',
        qualifier: 'retained_node',
        fromId: 'source',
        toId: 'item',
        relationId: 'old-edge',
        relationType: 'MENTIONS',
        incident: true,
        closed: false,
        clocks,
        recorded: {},
      },
    ],
  };
  store.db
    .transaction(() => {
      prepareMaterialization(store.db, write);
      commitSourceState(store.db, {
        sourceId: 'source',
        stateKind: 'unforgotten',
        operationId: 'materialize',
        at: NOW,
      });
      acknowledgeMaterialization(store.db, write, NOW.toISOString(), NOW.toISOString());
    })
    .immediate();
  expect(servedReferenceOutcome(store.db, 'item', SERVED)).toBe(expected);
});

it('repairs a missing searchable row when the verified indexing job is explicitly rerun', async () => {
  const logger = { warn: () => undefined, debug: () => undefined };
  const driver = { executeQuery: async () => ({ records: [] }) } as unknown as Driver;
  const resolver = new EvidenceResolver({ db: store.db, driver, logger });
  const deps = { db: store.db, resolver, logger, now: () => NOW };
  expect(await runSourceIndexJob(deps, { sourceId: 'source' })).toMatchObject({
    status: 'indexed',
    complete: true,
  });
  store.db
    .prepare(
      'DELETE FROM source_search_fts WHERE rowid IN (SELECT id FROM source_search_documents WHERE source_id=?)',
    )
    .run('source');
  expect(searchIndexPin(store.db, 'source').pinned).toBe(true);
  expect
    .soft(await runSourceIndexJob(deps, { sourceId: 'source' }))
    .toMatchObject({ status: 'indexed', complete: true });
  expect(searchIndexPin(store.db, 'source').pinned).toBe(false);
});
