import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { proposalHygieneOperation } from './proposal-hygiene.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  getEntityMergeProposal,
  recordEntityMergeProposal,
} from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  getSupersessionProposal,
  recordSupersessionProposal,
} from '../../../infrastructure/sqlite/supersession-proposals.js';
import type { OperationContext } from '../../domain/operation.js';
import { hygieneLedgerKey } from '../../domain/proposal-hygiene.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { staleMergeLedgerKey } from '../stale-merge-sweep.js';

/**
 * A fake recognising the exact two read shapes this operation issues (the episode provenance
 * join and the entity-currency check), the same way `fake-graph.fixture.ts` models intake's
 * writes: it throws on anything else, so a query shape change fails the fake loudly rather
 * than answering something it does not actually model. Live behaviour is proven against a
 * real Neo4j in `proposal-hygiene.int.test.ts`.
 */
type FakeEpisode = {
  readonly occurredAt: Date;
  readonly turnCount: number;
  readonly toolExecutionCount: number;
};
type FakeEntity = { readonly current: boolean };

function fakeDriver(
  episodes: ReadonlyMap<string, FakeEpisode> = new Map(),
  entities: ReadonlyMap<string, FakeEntity> = new Map(),
  onEpisodeQuery?: () => void,
): Driver {
  const executeQuery = (cypher: string, parameters: Record<string, unknown>): Promise<unknown> => {
    const ids = (parameters.ids as string[] | undefined) ?? [];
    if (cypher.includes('n IS NULL')) {
      // The stale sweep's currency check. An id the map does not carry has no node behind it,
      // which the real query also reports as gone.
      const records = ids
        .filter((id) => entities.get(id)?.current !== true)
        .map((id) => ({ toObject: () => ({ id }) }));
      return Promise.resolve({ records });
    }
    if (cypher.includes('MATCH (e:Episode')) {
      onEpisodeQuery?.();
      const records = ids
        .filter((id) => episodes.has(id))
        .map((id) => {
          const episode = episodes.get(id);
          return {
            toObject: () => ({
              id,
              occurred_at: episode?.occurredAt,
              turn_count: episode?.turnCount,
              tool_execution_count: episode?.toolExecutionCount,
              origin_channel: undefined,
              origin_event: undefined,
            }),
          };
        });
      return Promise.resolve({ records });
    }
    if (cypher.includes('MATCH (n:Entity')) {
      const records = ids
        .filter((id) => entities.has(id))
        .map((id) => ({
          toObject: () => ({
            id,
            name: '',
            name_norm: '',
            type: '',
            is_structural: false,
            name_vec: undefined,
            current: entities.get(id)?.current === true,
            tx_from: undefined,
            aliases: [],
            access_count: 0,
            last_accessed: undefined,
            mentionCount: 0,
          }),
        }));
      return Promise.resolve({ records });
    }
    throw new Error(`proposal-hygiene fake driver does not model this query: ${cypher}`);
  };
  return { executeQuery } as unknown as Driver;
}

function answering(answer: unknown): Provider {
  return {
    embed: () => Promise.reject(new Error('proposal hygiene must never embed')),
    generate: () => Promise.resolve(answer),
  };
}

const NOW = new Date('2026-08-29T14:00:00.000Z');
const OLD_CREATED = new Date(NOW.getTime() - 20 * 86_400_000);
const FRESH_CREATED = NOW;

let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-proposal-hygiene-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM entity_merge_proposals');
  db.exec('DELETE FROM supersession_proposals');
  db.exec('DELETE FROM ops_ledger');
});

function ctxFor(
  config: Config = DEFAULTS,
  overrides: Partial<OperationContext> = {},
): OperationContext {
  return {
    driver: fakeDriver(),
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('proposal_hygiene with the knob off', () => {
  it('examines nothing and says the knob is why', async () => {
    recordSupersessionProposal(db, {
      oldId: 'old-1',
      newId: 'new-1',
      confidence: 0.5,
      episodeId: 'ep-1',
      createdAt: OLD_CREATED.toISOString(),
    });
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, proposalHygiene: false },
    };

    const result = await proposalHygieneOperation().run(ctxFor(config));

    expect(result).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'proposal hygiene disabled by AION_MAINTENANCE_PROPOSAL_HYGIENE; no rows examined',
    });
  });
});

describe('proposal_hygiene judge routing', () => {
  function seedFuzzyPair(id: { left: string; right: string; episode: string }): string {
    return recordEntityMergeProposal(db, {
      subject: { id: id.left, name: 'Ledger Cache', type: 'tool' },
      candidate: { id: id.right, name: 'Ledger Store', type: 'concept' },
      similarity: 0.6,
      similaritySource: 'name_cosine',
      episodeId: id.episode,
      createdAt: OLD_CREATED.toISOString(),
    });
  }

  function bothCurrentDriver(episodeId: string, left: string, right: string): Driver {
    return fakeDriver(
      new Map([[episodeId, { occurredAt: OLD_CREATED, turnCount: 2, toolExecutionCount: 1 }]]),
      new Map([
        [left, { current: true }],
        [right, { current: true }],
      ]),
    );
  }

  it('dismisses a pair the judge calls distinct, recording the verdict', async () => {
    const id = seedFuzzyPair({ left: 'left-1', right: 'right-1', episode: 'ep-1' });
    const driver = bothCurrentDriver('ep-1', 'left-1', 'right-1');
    const provider = answering({ verdict: 'distinct', reason: 'one is the tool, one is the data' });

    const result = await proposalHygieneOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(1);
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    const entry = getLedgerEntry(db, hygieneLedgerKey('entity_merge', id));
    expect(entry?.summary).toMatchObject({ class: 'ordinary_residue', verdict: 'distinct' });
  });

  it('dismisses a pair the judge calls same, recording the verdict for a future fuzzy-merge lane', async () => {
    const id = seedFuzzyPair({ left: 'left-2', right: 'right-2', episode: 'ep-2' });
    const driver = bothCurrentDriver('ep-2', 'left-2', 'right-2');
    const provider = answering({ verdict: 'same', reason: 'both name the caching layer' });

    const result = await proposalHygieneOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(1);
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    const entry = getLedgerEntry(db, hygieneLedgerKey('entity_merge', id));
    expect(entry?.summary).toMatchObject({ class: 'ordinary_residue', verdict: 'same' });
  });

  it('leaves a row unstamped and open when the judge call fails', async () => {
    const id = seedFuzzyPair({ left: 'left-3', right: 'right-3', episode: 'ep-3' });
    const driver = bothCurrentDriver('ep-3', 'left-3', 'right-3');
    const provider: Provider = {
      embed: () => Promise.reject(new Error('must not embed')),
      generate: () => Promise.reject(new Error('model unavailable')),
    };

    const result = await proposalHygieneOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(0);
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBeNull();
    expect(getLedgerEntry(db, hygieneLedgerKey('entity_merge', id))).toBeUndefined();
  });

  it('resolves a stale-sided pair through the sweep, with no horizon and no judge call', async () => {
    // Created now, not twenty days ago: the sweep owns a pair with a closed side, and a pair
    // with nothing left to merge is finished rather than undecided, so it does not wait.
    const id = recordEntityMergeProposal(db, {
      subject: { id: 'left-4', name: 'Ledger Cache', type: 'tool' },
      candidate: { id: 'right-4', name: 'Ledger Store', type: 'topic' },
      similarity: 0.6,
      similaritySource: 'name_cosine',
      episodeId: 'ep-4',
      createdAt: FRESH_CREATED.toISOString(),
    });
    const driver = fakeDriver(
      new Map([['ep-4', { occurredAt: FRESH_CREATED, turnCount: 2, toolExecutionCount: 1 }]]),
      new Map([
        ['left-4', { current: true }],
        ['right-4', { current: false }],
      ]),
    );

    const result = await proposalHygieneOperation().run(
      ctxFor(DEFAULTS, { driver, provider: refusingProvider }),
    );

    expect(result.itemsAffected).toBe(1);
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    expect(getLedgerEntry(db, staleMergeLedgerKey(id))?.summary).toMatchObject({
      reason: 'a side of this pair lost currency, so there is nothing left to merge',
      goneSides: ['right-4'],
    });
    // The horizon pass never saw it, so it wrote nothing about it either.
    expect(getLedgerEntry(db, hygieneLedgerKey('entity_merge', id))).toBeUndefined();
  });
});

describe('proposal_hygiene judge batch cap', () => {
  it('judges only the configured number of pairs in one run', async () => {
    const firstId = recordEntityMergeProposal(db, {
      subject: { id: 'left-a', name: 'A', type: 'tool' },
      candidate: { id: 'right-a', name: 'A Prime', type: 'concept' },
      similarity: 0.6,
      similaritySource: 'name_cosine',
      episodeId: 'ep-a',
      createdAt: OLD_CREATED.toISOString(),
    });
    const secondId = recordEntityMergeProposal(db, {
      subject: { id: 'left-b', name: 'B', type: 'tool' },
      candidate: { id: 'right-b', name: 'B Prime', type: 'concept' },
      similarity: 0.6,
      similaritySource: 'name_cosine',
      episodeId: 'ep-b',
      createdAt: new Date(OLD_CREATED.getTime() + 1_000).toISOString(),
    });
    const driver = fakeDriver(
      new Map([
        ['ep-a', { occurredAt: OLD_CREATED, turnCount: 2, toolExecutionCount: 1 }],
        ['ep-b', { occurredAt: OLD_CREATED, turnCount: 2, toolExecutionCount: 1 }],
      ]),
      new Map([
        ['left-a', { current: true }],
        ['right-a', { current: true }],
        ['left-b', { current: true }],
        ['right-b', { current: true }],
      ]),
    );
    let calls = 0;
    const provider: Provider = {
      embed: () => Promise.reject(new Error('must not embed')),
      generate: () => {
        calls += 1;
        return Promise.resolve({ verdict: 'distinct', reason: 'different' });
      },
    };
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, hygieneJudgeBatch: 1 },
    };

    const result = await proposalHygieneOperation().run(ctxFor(config, { driver, provider }));

    expect(calls).toBe(1);
    expect(result.itemsAffected).toBe(1);
    const resolutions = [
      getEntityMergeProposal(db, firstId)?.resolvedAt,
      getEntityMergeProposal(db, secondId)?.resolvedAt,
    ];
    // Oldest-first: the earlier-created pair is the one the single judge call reaches.
    expect(resolutions.filter((resolvedAt) => resolvedAt !== null)).toHaveLength(1);
  });
});

describe('proposal_hygiene scan ceiling', () => {
  it('reads at most 200 open rows in one run', async () => {
    for (let index = 0; index < 205; index += 1) {
      recordSupersessionProposal(db, {
        oldId: `old-${String(index)}`,
        newId: `new-${String(index)}`,
        confidence: 0.5,
        episodeId: `ep-${String(index)}`,
        createdAt: FRESH_CREATED.toISOString(),
      });
    }

    const result = await proposalHygieneOperation().run(ctxFor());

    expect(result.itemsProcessed).toBe(200);
    expect(result.itemsAffected).toBe(0);
  });
});

describe('proposal_hygiene abort', () => {
  it('processes nothing once the signal is already aborted', async () => {
    recordSupersessionProposal(db, {
      oldId: 'old-abort',
      newId: 'new-abort',
      confidence: 0.5,
      episodeId: 'ep-abort',
      createdAt: OLD_CREATED.toISOString(),
    });
    const controller = new AbortController();
    controller.abort();

    const result = await proposalHygieneOperation().run(
      ctxFor(DEFAULTS, { signal: controller.signal }),
    );

    expect(result).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail:
        '0 of 0 open proposal(s) dismissed past their hygiene horizon; ' +
        '0 of 0 merge proposal(s) resolved with a side that lost currency',
    });
  });
});

describe('proposal_hygiene race with another resolver', () => {
  it('counts and stamps nothing when the row was already resolved by the time it dismisses', async () => {
    const id = recordSupersessionProposal(db, {
      oldId: 'old-race',
      newId: 'new-race',
      confidence: 0.5,
      episodeId: 'ep-race',
      createdAt: OLD_CREATED.toISOString(),
    });
    // The episode read is the one graph call this row's path makes before its own dismiss, so
    // it is where a concurrent resolver's write is injected to land inside that window.
    const driver = fakeDriver(
      new Map([['ep-race', { occurredAt: OLD_CREATED, turnCount: 0, toolExecutionCount: 2 }]]),
      new Map(),
      () => {
        db.prepare('UPDATE supersession_proposals SET resolved_at = ? WHERE id = ?').run(
          '2026-08-20T00:00:00.000Z',
          id,
        );
      },
    );

    const result = await proposalHygieneOperation().run(
      ctxFor(DEFAULTS, { driver, provider: refusingProvider }),
    );

    expect(result.itemsAffected).toBe(0);
    expect(getSupersessionProposal(db, id)?.resolvedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(getLedgerEntry(db, hygieneLedgerKey('supersession', id))).toBeUndefined();
  });
});
