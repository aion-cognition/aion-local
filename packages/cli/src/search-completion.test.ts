import * as core from '@aion/core';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '@aion/core/infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '@aion/core/infrastructure/sqlite/database.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSearch } from './search.js';
import { Substrate } from './substrate.js';

/**
 * The command's own lifecycle, not a stand-in for it: coverage is decided before the graph is
 * required and before anything is embedded, and the contract is checked again before a result is
 * printed. The two awaits in between are where a contract moves, and an answer printed under a
 * statement that is no longer in force describes coverage the substrate does not have.
 */

const EARLY = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-02T00:00:00.000Z');

const state = vi.hoisted(() => ({ midRead: undefined as (() => void) | undefined, embedded: 0 }));

vi.mock('@aion/core', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    OllamaProvider: class {
      embed(texts: readonly string[]): Promise<number[][]> {
        state.embedded += 1;
        state.midRead?.();
        return Promise.resolve(texts.map(() => [1, 0, 0]));
      }
    },
  };
});

const logger = core.openLogger({ filePath: '/dev/null', level: 'error' });
const connection = { driver: {} } as core.GraphConnection;

let store: SqliteStore;
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
  vi.spyOn(Substrate.prototype, 'requireGraph').mockImplementation(() => {
    graphChecks += 1;
    return Promise.resolve(unavailable ? undefined : connection);
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

function search(argv: readonly string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  return runSearch(argv, (line: string) => lines.push(line)).then((code) => ({ code, lines }));
}

describe('coverage before the rest of the command', () => {
  it('decides coverage before the lifecycle asks the graph for anything', async () => {
    const { code, lines } = await search(['needle', '--knew-at', '2026-01-01', '--json']);

    expect(code).toBe(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      coverage_refusal: { reason: 'before_horizon' },
    });
    expect(state.embedded).toBe(0);
    expect(graphChecks).toBe(0);
  });

  it('refuses from the registry alone when the graph cannot be reached', async () => {
    unavailable = true;

    const { lines } = await search(['needle', '--knew-at', '2026-01-01', '--json']);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      coverage_refusal: { reason: 'before_horizon' },
    });
  });

  it('still requires the graph for a request that passes coverage', async () => {
    unavailable = true;

    const { code, lines } = await search(['needle', '--json']);

    expect(code).toBe(1);
    expect(graphChecks).toBe(1);
    expect(lines).toEqual([]);
  });
});

describe('coverage again before a result is printed', () => {
  /**
   * The activation moves the epoch and not the horizon: this campaign fixes H at the first
   * activation and every revision after it copies both moments forward. So the bounds a caller
   * is handed are the ones the record in force actually states, which is what "current verified
   * bounds" means — not the clock the second activation was called with.
   */
  it('refuses an activation that lands between the preflight and the answer', async () => {
    state.midRead = () => {
      activateCoverageContract(store.db, { activatedAt: LATER, fieldPolicyVersion: 1 });
    };

    const { code, lines } = await search(['needle', '--json']);

    expect(code).toBe(1);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      schema_version: 1,
      results: [],
      coverage_refusal: {
        contract_version: 1,
        reason: 'coverage_changed',
        requested: { now: expect.any(String) },
        bounds: { coverage_state: 'active', history_since: EARLY.toISOString() },
      },
    });
  });

  it('refuses a registry that stopped being readable while the read was in flight', async () => {
    state.midRead = () => {
      store.db.exec('ALTER TABLE coverage_contract RENAME TO review_coverage_contract');
    };

    try {
      const { code, lines } = await search(['needle', '--json']);

      expect(code).toBe(1);
      expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
        results: [],
        coverage_refusal: { reason: 'coverage_store_unavailable', bounds: {} },
      });
    } finally {
      store.db.exec('ALTER TABLE review_coverage_contract RENAME TO coverage_contract');
    }
  });

  it('serves the unchanged contract, embedding once', async () => {
    const { code, lines } = await search(['needle', '--json']);

    expect(code).toBe(0);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      results: [{ id: 'old-result' }],
      coverage: { status: 'supported' },
    });
    expect(state.embedded).toBe(1);
  });
});
