import * as core from '@aion/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { runSearch } from './search.js';
import { Substrate } from './substrate.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../core/src/infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../core/src/infrastructure/sqlite/database.js';

const state = vi.hoisted(() => ({ midRead: undefined as (() => void) | undefined, embedded: 0 }));
vi.mock('@aion/core', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    OllamaProvider: class {
      embed(texts: readonly string[]) {
        state.embedded += 1;
        state.midRead?.();
        return Promise.resolve(texts.map(() => [1, 0, 0]));
      }
    },
  };
});
let store: SqliteStore;
const EARLY = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-02T00:00:00.000Z');
const logger = core.openLogger({ filePath: '/dev/null', level: 'error' });
const connection = { driver: {} } as core.GraphConnection;
let graphChecks = 0;
let unavailable = false;
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: EARLY, fieldPolicyVersion: 1 });
  state.midRead = undefined;
  state.embedded = 0;
  graphChecks = 0;
  unavailable = false;
  vi.spyOn(core, 'loadConfig').mockReturnValue(core.DEFAULTS);
  vi.spyOn(Substrate.prototype, 'db').mockReturnValue(store.db);
  vi.spyOn(Substrate.prototype, 'logger').mockReturnValue(logger);
  vi.spyOn(Substrate.prototype, 'connection').mockReturnValue(connection);
  vi.spyOn(Substrate.prototype, 'requireGraph').mockImplementation(async () => {
    graphChecks += 1;
    return unavailable ? undefined : connection;
  });
  vi.spyOn(core, 'selectSeeds').mockResolvedValue({
    seeds: [
      {
        id: 'old-result',
        labels: ['Memory'],
        content: 'old contents',
        currency: 'current',
        score: 1,
        relevance: 1,
        provenance: [],
      },
    ],
    byStrategy: { vector: [], bm25: [], entity_resolution: [], context_vector: [], recency: [] },
    graphUnavailable: false,
    budget: 1,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

it('checks coverage before the real CLI lifecycle asks graph reachability', async () => {
  const lines: string[] = [];
  expect(
    await runSearch(['needle', '--knew-at', '2026-01-01', '--json'], (line) => lines.push(line)),
  ).toBe(1);
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    coverage_refusal: { reason: 'before_horizon' },
  });
  expect.soft(state.embedded).toBe(0);
  expect.soft(graphChecks).toBe(0);
});

it('still reports a coverage refusal when graph reachability is unavailable', async () => {
  unavailable = true;
  const lines: string[] = [];
  await runSearch(['needle', '--knew-at', '2026-01-01', '--json'], (line) => lines.push(line));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    coverage_refusal: { reason: 'before_horizon' },
  });
});

it('refuses a coverage activation after CLI preflight before emitting seeds', async () => {
  state.midRead = () =>
    activateCoverageContract(store.db, { activatedAt: LATER, fieldPolicyVersion: 1 });
  const lines: string[] = [];
  const code = await runSearch(['needle', '--json'], (line) => lines.push(line));
  expect.soft(code).toBe(1);
  expect.soft(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    results: [],
    coverage_refusal: {
      reason: 'coverage_changed',
      bounds: { history_since: LATER.toISOString() },
    },
  });
});

it('refuses an unreadable registry at CLI completion', async () => {
  state.midRead = () =>
    store.db.exec('ALTER TABLE coverage_contract RENAME TO review_coverage_contract');
  const lines: string[] = [];
  try {
    const code = await runSearch(['needle', '--json'], (line) => lines.push(line));
    expect.soft(code).toBe(1);
    expect.soft(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      results: [],
      coverage_refusal: { reason: 'coverage_store_unavailable', bounds: {} },
    });
  } finally {
    store.db.exec('ALTER TABLE review_coverage_contract RENAME TO coverage_contract');
  }
});

it('serves the unchanged-contract CLI control', async () => {
  const lines: string[] = [];
  expect(await runSearch(['needle', '--json'], (line) => lines.push(line))).toBe(0);
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    results: [{ id: 'old-result' }],
    coverage: { status: 'supported' },
  });
  expect(state.embedded).toBe(1);
});
