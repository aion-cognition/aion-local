import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { runSourceIndexJob } from './source-index.js';
import { runSourceInspection } from './source-inspect.js';
import { runSourceSearch } from './source-search.js';
import { searchText } from './source-wire.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { seedSource, commitSourceState } from '../../evidence/test-support/evidence.fixture.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { searchProjectionExists } from '../../infrastructure/sqlite/fts-capability.js';
import { searchIndexPin } from '../../infrastructure/sqlite/source-search-store.js';
import { SOURCE_SEARCH_LIMITS } from '../domain/source-search.js';

const H = new Date('2026-09-01T00:00:00.000Z');
const NOW = new Date('2026-09-08T10:00:00.000Z');
let dir: string;
let store: SqliteStore;
let resolver: EvidenceResolver;
const logger = { warn: () => undefined, debug: () => undefined };
const driver = { executeQuery: async () => ({ records: [] }) } as unknown as Driver;

function seed(id: string, text: string): void {
  seedSource(store.db, {
    sourceId: id,
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text }] },
    turnIds: [`${id}-turn`],
    now: NOW,
  });
}
function deps() {
  return { db: store.db, resolver, now: () => NOW, logger };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-source-tools-review-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: H, fieldPolicyVersion: 1 });
  resolver = new EvidenceResolver({ db: store.db, driver, logger });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('does not create the projection on a request that coverage refuses', async () => {
  expect(searchProjectionExists(store.db)).toBe(false);
  const result = await runSourceSearch(deps(), {
    query: 'needle',
    knewAt: '2026-09-09T00:00:00.000Z',
  });
  expect.soft(result.status).toBe('coverage_refused');
  expect.soft(searchProjectionExists(store.db)).toBe(false);
});

it('discloses missing index coverage on a zero-hit search', async () => {
  seed('unindexed', 'needle is archived but not indexed');
  const result = await runSourceSearch(deps(), { query: 'needle' });
  expect(result.status).toBe('results');
  if (result.status !== 'results') {
    return;
  }
  expect(result.results).toEqual([]);
  expect(result.coverage.gaps.some((gap) => gap.reason === 'bounded_read')).toBe(true);
});

it('pages within the text bound when one verified part exceeds a response', async () => {
  seed('large', `needle ${'x'.repeat(80 * 1024)} TAIL`);
  const result = await runSourceInspection(deps(), { id: 'large' });
  expect(result.status).toBe('source');
  if (result.status !== 'source') {
    return;
  }
  const bytes = result.parts.reduce((n, part) => n + Buffer.byteLength(part.text, 'utf8'), 0);
  expect.soft(bytes).toBeLessThanOrEqual(SOURCE_SEARCH_LIMITS.maxResponseTextBytes);
  expect.soft(result.continuation).toBeDefined();
});

it('checks the coverage epoch again before returning source text', async () => {
  seed('source', 'needle');
  const real = resolver.resolveSources.bind(resolver);
  vi.spyOn(resolver, 'resolveSources').mockImplementation(async (...args) => {
    const result = await real(...args);
    prepareCoverageContract(store.db, 1);
    activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });
    return result;
  });
  const result = await runSourceInspection(deps(), { id: 'source' });
  expect(result.status).toBe('coverage_refused');
});

it('reports the newly verified bounds when search detects a changed epoch', async () => {
  seed('source', 'needle');
  await runSourceIndexJob(deps(), { sourceId: 'source' });
  const real = resolver.resolveSources.bind(resolver);
  vi.spyOn(resolver, 'resolveSources').mockImplementation(async (...args) => {
    const result = await real(...args);
    prepareCoverageContract(store.db, 1);
    activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });
    return result;
  });
  const result = await runSourceSearch(deps(), { query: 'needle' });
  expect(result.status).toBe('coverage_refused');
  if (result.status === 'coverage_refused') {
    expect(result.refusal.bounds.history_since).toBe(NOW.toISOString());
  }
});

it('does not turn an unreadable registry at search completion into an ordinary epoch change', async () => {
  seed('source', 'needle');
  await runSourceIndexJob(deps(), { sourceId: 'source' });
  const real = resolver.resolveSources.bind(resolver);
  vi.spyOn(resolver, 'resolveSources').mockImplementation(async (...args) => {
    const result = await real(...args);
    store.db.exec('ALTER TABLE coverage_contract RENAME TO coverage_contract_review');
    return result;
  });
  try {
    const result = await runSourceSearch(deps(), { query: 'needle' });
    expect(result.status).toBe('coverage_refused');
    if (result.status === 'coverage_refused') {
      expect(result.refusal.reason).toBe('coverage_store_unavailable');
      expect(result.refusal.bounds).toEqual({});
    }
  } finally {
    store.db.exec('ALTER TABLE coverage_contract_review RENAME TO coverage_contract');
  }
});

it('does not skip unresolved documents when a page exhausts its raw read allowance', async () => {
  const expected = new Set<string>();
  for (let n = 0; n < 6; n += 1) {
    const id = `long-${String(n)}`;
    expected.add(id);
    seed(id, `needle ${'x'.repeat(80 * 1024)}${id}`);
    expect((await runSourceIndexJob(deps(), { sourceId: id })).status).toBe('indexed');
  }
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 8; page += 1) {
    const result = await runSourceSearch(deps(), {
      query: 'needle',
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(result.status).toBe('results');
    if (result.status !== 'results') {
      return;
    }
    result.results.forEach((hit) => seen.add(hit.sourceId));
    cursor = result.continuation;
    if (cursor === undefined) {
      break;
    }
  }
  expect(seen).toEqual(expected);
});

it('does not release the index pin from document count alone', async () => {
  seedSource(store.db, {
    sourceId: 'two',
    sessionId: 'session',
    identity: 'review',
    now: NOW,
    content: {
      turns: [
        { role: 'user', text: 'needle one' },
        { role: 'assistant', text: 'needle two' },
      ],
    },
    turnIds: ['two-a', 'two-b'],
  });
  await runSourceIndexJob(deps(), { sourceId: 'two' });
  store.db
    .prepare(
      'UPDATE source_search_documents SET part_ordinal=999 WHERE source_id=? AND part_ordinal=1',
    )
    .run('two');
  expect(searchIndexPin(store.db, 'two').pinned).toBe(true);
});

it('does not disclose an earlier hit after its source is forgotten during the page', async () => {
  seed('first', 'needle first');
  seed('second', 'needle second');
  await runSourceIndexJob(deps(), { sourceId: 'first' });
  await runSourceIndexJob(deps(), { sourceId: 'second' });
  const real = resolver.resolveSources.bind(resolver);
  vi.spyOn(resolver, 'resolveSources').mockImplementation(async (...args) => {
    const result = await real(...args);
    const address = args[0][0];
    if (address?.kind === 'part' && address.sourceId === 'second') {
      commitSourceState(store.db, {
        sourceId: 'first',
        stateKind: 'forgotten',
        operationId: 'forget-mid-page',
        at: NOW,
      });
    }
    return result;
  });
  const result = await runSourceSearch(deps(), { query: 'needle' });
  if (result.status === 'results') {
    expect(result.results.some((hit) => hit.sourceId === 'first')).toBe(false);
  }
});

it('escapes captured terminal controls in text excerpts', () => {
  const control = String.fromCharCode(27);
  const rendered = searchText({
    schema_version: 1,
    status: 'results',
    results: [
      {
        source_id: 'source',
        part_kind: 'turn',
        ordinal: 0,
        session_id: 'session',
        source_occurred_at: NOW.toISOString(),
        part_clock: 'not_recorded',
        excerpt: `${control}[2Jneedle`,
        excerpt_start: 0,
        excerpt_end: 10,
        residency: 'resident',
        evidence: 'complete-for-use',
        indexed_bytes: 10,
        truncated: false,
      },
    ],
  });
  expect(rendered.includes(control)).toBe(false);
});
