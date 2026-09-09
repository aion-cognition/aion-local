import type { Driver } from 'neo4j-driver';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { runSourceIndexJob } from './source-index.js';
import { runSourceInspection } from './source-inspect.js';
import { runSourceSearch } from './source-search.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { SOURCE_STATE_SCOPE } from '../../evidence/domain/scopes.js';
import { seedSource, establishScope } from '../../evidence/test-support/evidence.fixture.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  searchIndexPin,
  corpusCoverage,
  writeSearchDocument,
} from '../../infrastructure/sqlite/source-search-store.js';

const START = new Date('2026-09-01T10:00:00.000Z');
const SERVED = new Date('2026-09-04T10:00:00.000Z');
const NOW = new Date('2026-09-08T10:00:00.000Z');
let dir: string;
let store: SqliteStore;
let resolver: EvidenceResolver;
const logger = { warn: () => undefined, debug: () => undefined };
const driver = { executeQuery: async () => ({ records: [] }) } as unknown as Driver;

function seed(text: string): void {
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text }] },
    turnIds: ['turn'],
    now: START,
  });
}

function deps() {
  return { db: store.db, resolver, now: () => NOW, logger };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-t7f1-boundaries-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: START, fieldPolicyVersion: 1 });
  resolver = new EvidenceResolver({ db: store.db, driver, logger });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function loseCensusAfterRead(): void {
  establishScope(store.db, 'source', SOURCE_STATE_SCOPE, START);
  const real = resolver.resolveSources.bind(resolver);
  vi.spyOn(resolver, 'resolveSources').mockImplementation(async (...args) => {
    const batch = await real(...args);
    expect([...batch.results.values()][0]?.value).toBeDefined();
    store.db
      .prepare(
        "UPDATE evidence_scope_versions SET census_status='unknown' WHERE endpoint_id=? AND relation_class=?",
      )
      .run('source', SOURCE_STATE_SCOPE);
    return batch;
  });
}

it('discloses lost historical eligibility proof at inspection completion as uncertainty', async () => {
  seed('needle');
  loseCensusAfterRead();
  const result = await runSourceInspection(deps(), { id: 'source', knewAt: SERVED.toISOString() });
  expect(result.status).toBe('unavailable');
  if (result.status !== 'unavailable') {
    return;
  }
  expect.soft(result.evidence).not.toBe('not-found-in-coverage');
  expect(result.coverage.gaps.length).toBeGreaterThan(0);
});

it('discloses lost historical eligibility proof on an empty search page', async () => {
  seed('needle');
  await runSourceIndexJob(deps(), { sourceId: 'source' });
  loseCensusAfterRead();
  const result = await runSourceSearch(deps(), { query: 'needle', knewAt: SERVED.toISOString() });
  expect(result.status).toBe('results');
  if (result.status !== 'results') {
    return;
  }
  expect(result.results).toEqual([]);
  expect(result.coverage.gaps.length).toBeGreaterThan(0);
});

it('does not certify coverage for a current-address document containing different bytes', async () => {
  seed('needle is the verified raw text');
  await runSourceIndexJob(deps(), { sourceId: 'source' });
  expect(searchIndexPin(store.db, 'source')).toEqual({ pinned: false });
  const wrong = 'different source words';
  writeSearchDocument(store.db, {
    sourceId: 'source',
    partKind: 'turn',
    partOrdinal: 0,
    body: wrong,
    contentDigest: createHash('sha256').update(wrong).digest('hex'),
    truncated: false,
    indexedBytes: Buffer.byteLength(wrong),
  });
  expect.soft(searchIndexPin(store.db, 'source').pinned).toBe(true);
  const corpus = corpusCoverage(store.db);
  expect.soft(corpus.coveredParts).toBeLessThan(corpus.recordedParts);
  const result = await runSourceSearch(deps(), { query: 'needle' });
  expect(result.status).toBe('results');
  if (result.status === 'results') {
    expect.soft(result.results).toEqual([]);
    expect(result.coverage.gaps.length).toBeGreaterThan(0);
  }
});

it('does not certify a metadata row whose searchable document is absent', async () => {
  seed('needle');
  await runSourceIndexJob(deps(), { sourceId: 'source' });
  store.db
    .prepare(
      'DELETE FROM source_search_fts WHERE rowid IN (SELECT id FROM source_search_documents WHERE source_id=?)',
    )
    .run('source');
  expect.soft(searchIndexPin(store.db, 'source').pinned).toBe(true);
  const result = await runSourceSearch(deps(), { query: 'needle' });
  expect(result.status).toBe('results');
  if (result.status === 'results') {
    expect(result.coverage.gaps.length).toBeGreaterThan(0);
  }
});

it('preserves a complete historical hit with a valid unchanged census', async () => {
  seed('needle');
  establishScope(store.db, 'source', SOURCE_STATE_SCOPE, START);
  await runSourceIndexJob(deps(), { sourceId: 'source' });
  const result = await runSourceSearch(deps(), { query: 'needle', knewAt: SERVED.toISOString() });
  expect(result.status).toBe('results');
  if (result.status === 'results') {
    expect(result.results.map((hit) => hit.sourceId)).toEqual(['source']);
    expect(result.coverage.gaps).toEqual([]);
  }
});
