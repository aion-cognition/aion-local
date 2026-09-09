import {
  openLogger,
  openSqliteHandle,
  recallResultFor,
  refusalLines,
  type Logger,
  type Seed,
  type SqliteHandle,
} from '@aion/core';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '@aion/core/infrastructure/sqlite/coverage-contract.js';
import { callTool, type ToolBackend } from '@aion/mcp';
import type { RecallResult } from '@aion/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseSearchFlags,
  renderSearchResults,
  searchCoverage,
  searchEnvelope,
  writeSearchAnswer,
  type SearchFlags,
} from './search.js';

/** Nothing under test reads the log, and a tool call needs one. */
function quietLogger(): Logger {
  return openLogger({ filePath: '/dev/null', level: 'error' });
}

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('parseSearchFlags', () => {
  it('reads a plain query with no flags', () => {
    expect(parseSearchFlags(['webhooks ingestion'])).toEqual({
      query: 'webhooks ingestion',
      json: false,
    });
  });

  it('joins an unquoted multi-word query back into one string', () => {
    expect(parseSearchFlags(['webhooks', 'ingestion'])).toEqual({
      query: 'webhooks ingestion',
      json: false,
    });
  });

  it('reads --json and --as-of/--knew-at as ISO timestamps', () => {
    const flags = parseSearchFlags(['ingestion', '--as-of', '2026-06-01T00:00:00.000Z', '--json']);
    expect(flags.query).toBe('ingestion');
    expect(flags.json).toBe(true);
    expect(flags.asOf).toBe('2026-06-01T00:00:00.000Z');
  });

  it('reads both --as-of and --knew-at together', () => {
    const flags = parseSearchFlags([
      'ingestion',
      '--as-of',
      '2026-06-01T00:00:00.000Z',
      '--knew-at',
      '2026-06-02T00:00:00.000Z',
    ]);
    expect(flags.asOf).toBe('2026-06-01T00:00:00.000Z');
    expect(flags.knewAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('rejects a missing query, an unknown option, a missing value, or a bad timestamp', () => {
    expect(() => parseSearchFlags([])).toThrow('search needs a query');
    expect(() => parseSearchFlags(['q', '--bogus'])).toThrow(
      "unknown option '--bogus' for search (supported: --as-of, --knew-at, --json)",
    );
    expect(() => parseSearchFlags(['q', '--as-of'])).toThrow('--as-of needs a value');
    expect(() => parseSearchFlags(['q', '--as-of', 'not-a-date'])).toThrow(
      "--as-of got 'not-a-date', expected an ISO timestamp",
    );
  });
});

function seed(overrides: Partial<Seed> = {}): Seed {
  return {
    id: 'node-1',
    labels: ['Episode', 'Memory'],
    content: 'we picked webhooks for ingestion because polling was too slow',
    currency: 'current',
    score: 0.842,
    relevance: 0.842,
    provenance: [{ strategy: 'vector', score: 0.842, relevance: 0.842, cue: 'webhooks ingestion' }],
    ...overrides,
  };
}

describe('renderSearchResults', () => {
  it('says so when nothing matched', () => {
    const { lines, write } = collector();

    renderSearchResults([], write);

    expect(lines).toEqual(['no matches']);
  });

  it('renders id, label, score, and method per row', () => {
    const { lines, write } = collector();

    renderSearchResults([seed()], write);

    const text = lines.join('\n');
    expect(text).toContain('0.842');
    expect(text).toContain('vector');
    expect(text).toContain('Episode');
    expect(text).toContain('node-1');
    expect(text).toContain('we picked webhooks for ingestion');
  });

  it('truncates a long content preview', () => {
    const { lines, write } = collector();
    const long = 'x'.repeat(200);

    renderSearchResults([seed({ content: long })], write);

    const text = lines.join('\n');
    expect(text).toContain('…');
    expect(text).not.toContain(long);
  });
});

/**
 * The coverage decision at this command, and the two shapes it prints. The refusal is compared
 * against the one the tool transport carries for the same request, which is what makes the two
 * surfaces the same answer rather than two answers that happen to agree today.
 */
describe('coverage at the search command', () => {
  const NOW = new Date('2026-09-08T12:00:00.000Z');
  const ACTIVATED_AT = new Date('2026-09-08T02:00:00.000Z');

  let db: SqliteHandle;

  beforeEach(() => {
    db = openSqliteHandle({ filePath: ':memory:' });
    prepareCoverageContract(db, 1);
  });

  afterEach(() => {
    db.close();
  });

  function flagsFor(argv: readonly string[]): SearchFlags {
    return parseSearchFlags(argv);
  }

  it('rejects the forms the old parser silently accepted', () => {
    // `new Date` read every one of these; the protocol grammar reads none of them, so the two
    // surfaces can no longer answer the same text against different instants.
    for (const value of ['June 1 2026', '2026/06/01', '2026-06-01 10:00', '20260601']) {
      expect(() => flagsFor(['q', '--as-of', value])).toThrow('expected an ISO timestamp');
    }
    expect(flagsFor(['q', '--as-of', '2026-06-01']).asOf).toBe('2026-06-01');
  });

  it('prints the versioned envelope with the coverage statement beside the results', () => {
    activateCoverageContract(db, { activatedAt: ACTIVATED_AT, fieldPolicyVersion: 1 });
    const outcome = searchCoverage(db, flagsFor(['q']), NOW);
    const { lines, write } = collector();

    writeSearchAnswer(outcome, [seed()], true, write);

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      schema_version: 1,
      results: [expect.objectContaining({ id: 'node-1' })],
      coverage: {
        contract_version: 1,
        history_since: ACTIVATED_AT.toISOString(),
        status: 'supported',
        limitations: [],
        gaps: [],
      },
    });
  });

  it('prints a refusal with no results at all, in both shapes', () => {
    activateCoverageContract(db, { activatedAt: ACTIVATED_AT, fieldPolicyVersion: 1 });
    const flags = flagsFor(['q', '--knew-at', '2026-01-01T00:00:00.000Z']);
    const outcome = searchCoverage(db, flags, NOW);
    const json = collector();
    const text = collector();

    writeSearchAnswer(outcome, [], true, json.write);
    writeSearchAnswer(outcome, [], false, text.write);

    expect(JSON.parse(json.lines[0] ?? '')).toEqual({
      schema_version: 1,
      results: [],
      coverage_refusal: {
        contract_version: 1,
        reason: 'before_horizon',
        requested: { knew_at: '2026-01-01T00:00:00.000Z', now: NOW.toISOString() },
        bounds: { history_since: ACTIVATED_AT.toISOString(), coverage_state: 'active' },
      },
    });
    // The same words: a text-only reader is told the search was refused and why, never "no
    // matches", which is an answer.
    expect(text.lines.join('\n')).toContain('before_horizon');
    expect(text.lines.join('\n')).toContain(ACTIVATED_AT.toISOString());
    expect(text.lines.join('\n')).not.toContain('no matches');
  });

  it('names the preparing contract on a present answer and states no boundary', () => {
    const outcome = searchCoverage(db, flagsFor(['q']), NOW);
    const { lines, write } = collector();

    writeSearchAnswer(outcome, [], false, write);

    expect(outcome.status).toBe('checked');
    expect(lines.join('\n')).toContain('coverage_contract_not_active');
    expect(lines.join('\n')).toContain('no coverage boundary yet');
  });

  it('refuses a present search when the registry cannot be read', () => {
    db.prepare('ALTER TABLE coverage_contract RENAME TO coverage_contract_hidden').run();

    try {
      const outcome = searchCoverage(db, flagsFor(['q']), NOW);

      expect(outcome).toMatchObject({
        status: 'refused',
        refusal: { reason: 'coverage_store_unavailable', bounds: {} },
      });
    } finally {
      db.prepare('ALTER TABLE coverage_contract_hidden RENAME TO coverage_contract').run();
    }
  });

  /**
   * F11-A10: the same unsupported request, through the command line and through the tool, is
   * refused for the same reason against the same bounds and spends nothing either way.
   */
  it('refuses identically over the command line and over the tool', async () => {
    activateCoverageContract(db, { activatedAt: ACTIVATED_AT, fieldPolicyVersion: 1 });
    const flags = flagsFor(['q', '--knew-at', '2026-01-01T00:00:00.000Z']);
    const outcome = searchCoverage(db, flags, NOW);
    if (outcome.status !== 'refused') {
      throw new Error('the fixture contract refuses this request');
    }
    const refuse = (): Promise<RecallResult> =>
      Promise.resolve(recallResultFor({ status: 'coverage_refusal', refusal: outcome.refusal }));
    const backend = {
      recall: refuse,
      reflection: () => Promise.reject(new Error('not this test')),
      sourceSearch: () => Promise.reject(new Error('not this test')),
      source: () => Promise.reject(new Error('not this test')),
    } as unknown as ToolBackend;

    const tool = await callTool(backend, quietLogger(), 'recall', { query: 'q' }, 'session-a');
    const envelope = searchEnvelope(outcome, []);

    expect((tool.structuredContent as { coverage_refusal: unknown }).coverage_refusal).toEqual(
      envelope.coverage_refusal,
    );
    expect((tool.content[0] as { text: string }).text).toBe(
      refusalLines(outcome.refusal).join('\n'),
    );
  });
});
