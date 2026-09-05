import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  proposalResolutionOperation,
  proposalResolutionRelevance,
  resolutionLedgerKey,
} from './proposal-resolution.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
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
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * A fake recognising the read shapes this operation issues by the parameters each one binds,
 * the same way `proposal-hygiene.test.ts` models its own two: it throws on anything else, so a
 * query shape change fails the fake loudly rather than answering something it does not model.
 * It also models the one write transaction a supersession apply takes, which is what lets a
 * unit test see the applied path at all; live behaviour is proven in the int file beside it.
 */
type FakeNode = { readonly id: string; readonly label: string; readonly text: string };

type FakeReads = string[];

const NOW = new Date('2026-09-05T14:00:00.000Z');
const CREATED = new Date(NOW.getTime() - 3_600_000);

function record(row: Record<string, unknown>): { toObject: () => Record<string, unknown> } {
  return { toObject: () => row };
}

function readFor(
  nodes: ReadonlyMap<string, FakeNode>,
  reads: FakeReads,
  cypher: string,
  parameters: Record<string, unknown>,
): { toObject: () => Record<string, unknown> }[] {
  if (cypher.includes('labels(n) AS labels') && !cypher.includes('-[r]-')) {
    reads.push('provenance');
    const node = nodes.get(parameters.id as string);
    return node === undefined
      ? []
      : [record({ id: node.id, labels: [node.label], content: node.text })];
  }
  if (cypher.includes('RETURN DISTINCT e.id AS id')) {
    reads.push('subjects');
    return [
      record({
        id: 'entity-zephyr',
        name: 'Zephyr ingest',
        name_norm: 'zephyr ingest',
        text: 'Zephyr ingest (service): the ingest worker.',
        source_episode_id: 'ep-old',
      }),
    ];
  }
  if (parameters.nodeId !== undefined) {
    reads.push('source-episode');
    return [record({ id: 'ep-old' })];
  }
  if (parameters.episodeId !== undefined) {
    reads.push('episode');
    return [
      record({
        id: parameters.episodeId,
        session_id: 'session-1',
        text: 'the observation body',
        summary: 'a poll interval was discussed',
        occurred_at: CREATED,
        turns: [],
      }),
    ];
  }
  if (parameters.sessionId !== undefined) {
    reads.push('session-window');
    return [
      record({
        id: 'ep-old',
        text: 'Zephyr ingest polls every 45 seconds.',
        summary: 'the old poll interval',
        occurred_at: CREATED,
        tx_from: CREATED,
      }),
    ];
  }
  if (cypher.includes('UNWIND $ids AS wantedId')) {
    reads.push('entity-details');
    const ids = (parameters.ids as string[] | undefined) ?? [];
    return ids.map((id) =>
      record({
        id,
        name: id === 'left-1' ? 'Ledger Cache' : 'Ledger Store',
        name_norm: id,
        type: 'tool',
        is_structural: false,
        current: true,
        aliases: [],
        access_count: 0,
        mentionCount: 2,
        typeCounts: '{}',
        description: `${id} as first described`,
      }),
    );
  }
  if (parameters.pairs !== undefined) {
    reads.push('pair-signals');
    return [];
  }
  if (cypher.includes('-[r]-')) {
    reads.push('neighbourhood');
    return [
      record({
        type: 'RELATES_TO',
        outgoing: true,
        other_id: 'other-1',
        other_labels: ['Entity'],
        other_content: 'the ledger writer',
        strength: 1,
        confidence: 1,
        count: 1,
        provenance: [],
        signals: [],
      }),
    ];
  }
  throw new Error(`proposal-resolution fake driver does not model this query: ${cypher}`);
}

function writeFor(
  reads: FakeReads,
  cypher: string,
  parameters: Record<string, unknown>,
): { toObject: () => Record<string, unknown> }[] {
  if (cypher.includes('RETURN DISTINCT e.id AS id')) {
    return [];
  }
  if (parameters.oldId !== undefined) {
    reads.push('close');
    return [record({ id: parameters.oldId, validUntil: NOW, txUntil: NOW })];
  }
  if (parameters.sourceId !== undefined) {
    reads.push('lineage-edge');
    return [
      record({
        id: 'edge-1',
        sourceId: parameters.sourceId,
        targetId: parameters.targetId,
        strength: 1,
        confidence: 1,
        signals: [],
        provenance: [],
        count: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ];
  }
  if (cypher.includes('sibling')) {
    return [];
  }
  throw new Error(`proposal-resolution fake driver does not model this write: ${cypher}`);
}

function fakeDriver(nodes: readonly FakeNode[] = [], reads: FakeReads = []): Driver {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const executeQuery = (cypher: string, parameters: Record<string, unknown>): Promise<unknown> => {
    if (cypher.includes('UNWIND $ids AS closedId')) {
      reads.push('regrounding');
      return Promise.resolve({ records: [] });
    }
    return Promise.resolve({ records: readFor(byId, reads, cypher, parameters) });
  };
  const session = (): unknown => ({
    executeWrite: (work: (tx: unknown) => Promise<unknown>) =>
      work({
        run: (cypher: string, parameters: Record<string, unknown>) =>
          Promise.resolve({ records: writeFor(reads, cypher, parameters) }),
      }),
    close: () => Promise.resolve(),
  });
  return { executeQuery, session } as unknown as Driver;
}

type FakeAnswers = {
  readonly first?: unknown;
  readonly second?: unknown;
};

class CallCount {
  count = 0;

  bump(): void {
    this.count += 1;
  }
}

/** Routes each call by the schema it carries, so one fake answers both passes of either judge. */
function judgingProvider(answers: FakeAnswers, calls = new CallCount()): Provider {
  return {
    embed: () => Promise.reject(new Error('this operation must not embed')),
    generate: (request: StructuredRequest): Promise<unknown> => {
      calls.bump();
      const properties = (request.schema.properties ?? {}) as Record<string, unknown>;
      if ('contradicts' in properties || 'same' in properties) {
        return answers.first === undefined
          ? Promise.reject(new Error('the model is unavailable'))
          : Promise.resolve(answers.first);
      }
      return answers.second === undefined
        ? Promise.reject(new Error('the model is unavailable'))
        : Promise.resolve(answers.second);
    },
  };
}

const CONTRADICTS = { contradicts: true, confidence: 0.9, rationale: 'the poll interval changed' };
const STANDS = { contradicts: false, confidence: 0.9, rationale: 'two different subjects' };
const CLOSES = {
  reason: 'poll interval 45s against 5s',
  earlier_survives: false,
  newer_is_well_formed: true,
};
const VETOES = {
  reason: 'the earlier statement records one run',
  earlier_survives: true,
  newer_is_well_formed: true,
};

let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-proposal-resolution-'));
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

const PAIR: readonly FakeNode[] = [
  { id: 'old-1', label: 'Concept', text: 'Zephyr ingest polls every 45 seconds' },
  { id: 'new-1', label: 'Concept', text: 'Zephyr ingest polls every 5 seconds' },
];

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

function seedContradiction(oldId = 'old-1', newId = 'new-1', createdAt = CREATED): string {
  return recordSupersessionProposal(db, {
    oldId,
    newId,
    confidence: 0.9,
    rationale: 'poll interval',
    episodeId: 'ep-new',
    createdAt: createdAt.toISOString(),
  });
}

function seedMerge(left = 'left-1', right = 'right-1'): string {
  return recordEntityMergeProposal(db, {
    subject: { id: left, name: 'Ledger Cache', type: 'tool' },
    candidate: { id: right, name: 'Ledger Store', type: 'concept' },
    similarity: 0.61,
    similaritySource: 'name_cosine',
    episodeId: 'ep-merge',
    createdAt: CREATED.toISOString(),
  });
}

describe('proposalResolutionRelevance', () => {
  it('is zero with both queues empty, since there is nothing to decide', () => {
    expect(proposalResolutionRelevance(healthFixture())).toBe(0);
  });

  it('rises with the open count and saturates at one run of rows', () => {
    const health = healthFixture({
      proposals: {
        supersessionOpen: 5,
        entityMergeOpen: 0,
        oldestOpenAgeMs: 1000,
        medianOpenAgeMs: 1000,
      },
    });
    expect(proposalResolutionRelevance(health)).toBeCloseTo(0.5, 5);
    const full = healthFixture({
      proposals: {
        supersessionOpen: 40,
        entityMergeOpen: 20,
        oldestOpenAgeMs: 1000,
        medianOpenAgeMs: 1000,
      },
    });
    expect(proposalResolutionRelevance(full)).toBe(1);
  });
});

describe('proposal_resolution with the knob off', () => {
  it('examines nothing and says the knob is why', async () => {
    seedContradiction();
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, proposalResolution: false },
    };

    const result = await proposalResolutionOperation().run(ctxFor(config));

    expect(result).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'proposal resolution disabled by AION_PROPOSAL_RESOLUTION; no rows examined',
    });
  });
});

describe('proposal_resolution on a contradiction both passes affirm', () => {
  it('applies the correction, resolves the row, and ledgers the verdict with its grounds', async () => {
    const id = seedContradiction();
    const reads: FakeReads = [];
    const driver = fakeDriver(PAIR, reads);
    const provider = judgingProvider({ first: CONTRADICTS, second: CLOSES });

    const result = await proposalResolutionOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(1);
    expect(getSupersessionProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    expect(reads).toContain('close');
    const entry = getLedgerEntry(db, resolutionLedgerKey('supersession', id));
    expect(entry?.summary).toMatchObject({
      verdict: 'applied',
      oldId: 'old-1',
      newId: 'new-1',
      closed: ['old-1'],
    });
    expect((entry?.summary as { grounds: string }).grounds).toContain('poll interval');
  });

  it('puts the subject family and the session window in front of both passes', async () => {
    seedContradiction();
    const reads: FakeReads = [];
    const driver = fakeDriver(PAIR, reads);
    const asked: string[] = [];
    const answers = judgingProvider({ first: CONTRADICTS, second: CLOSES });
    const provider: Provider = {
      embed: answers.embed,
      generate: (request: StructuredRequest) => {
        asked.push(request.messages.map((message) => message.content).join('\n'));
        return answers.generate(request);
      },
    };

    await proposalResolutionOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(reads).toContain('subjects');
    expect(reads).toContain('session-window');
    // Both passes read wider than the filing judge did, which is the only way a call at
    // temperature 0 can reach a different answer than the one that filed the row.
    expect(asked).toHaveLength(2);
    for (const prompt of asked) {
      expect(prompt).toContain('Zephyr ingest polls every 45 seconds');
      expect(prompt).toContain('currently described as: Zephyr ingest (service)');
      expect(prompt).toContain('from session session-1');
      expect(prompt).toContain('the old poll interval');
    }
  });
});

describe('proposal_resolution on a contradiction the passes split on', () => {
  it('dismisses the row and records the veto as the grounds', async () => {
    const id = seedContradiction();
    const reads: FakeReads = [];
    const driver = fakeDriver(PAIR, reads);
    const provider = judgingProvider({ first: CONTRADICTS, second: VETOES });

    const result = await proposalResolutionOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(1);
    expect(getSupersessionProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    expect(reads).not.toContain('close');
    const entry = getLedgerEntry(db, resolutionLedgerKey('supersession', id));
    expect(entry?.summary).toMatchObject({ verdict: 'dismissed' });
    expect((entry?.summary as { grounds: string }).grounds).toContain('survival');
  });

  it('dismisses a row both passes decline, closing nothing', async () => {
    const id = seedContradiction();
    const reads: FakeReads = [];
    const driver = fakeDriver(PAIR, reads);
    const provider = judgingProvider({ first: STANDS, second: VETOES });

    const result = await proposalResolutionOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(1);
    expect(getSupersessionProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    expect(reads).not.toContain('close');
    expect(getLedgerEntry(db, resolutionLedgerKey('supersession', id))?.summary).toMatchObject({
      verdict: 'dismissed',
    });
  });
});

describe('proposal_resolution when a model call fails', () => {
  it('leaves the row open and unstamped for the next run', async () => {
    const id = seedContradiction();
    const driver = fakeDriver(PAIR);
    const provider = judgingProvider({ first: CONTRADICTS });

    const result = await proposalResolutionOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(0);
    expect(getSupersessionProposal(db, id)?.resolvedAt).toBeNull();
    expect(getLedgerEntry(db, resolutionLedgerKey('supersession', id))).toBeUndefined();
  });
});

describe('proposal_resolution on an entity-merge pair', () => {
  it('dismisses a pair the passes do not both call one referent', async () => {
    const id = seedMerge();
    const driver = fakeDriver();
    const provider = judgingProvider({
      first: { same: true, rationale: 'both name the cache' },
      second: { different_referent: true, reason: 'one is the store, one is the cache' },
    });

    const result = await proposalResolutionOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(1);
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    const entry = getLedgerEntry(db, resolutionLedgerKey('entity_merge', id));
    expect(entry?.summary).toMatchObject({ verdict: 'dismissed', leftId: 'left-1' });
    expect((entry?.summary as { grounds: string }).grounds).toContain('store');
  });

  it('leaves a pair open when the second pass never answers', async () => {
    const id = seedMerge();
    const driver = fakeDriver();
    const provider = judgingProvider({ first: { same: true, rationale: 'both name the cache' } });

    const result = await proposalResolutionOperation().run(ctxFor(DEFAULTS, { driver, provider }));

    expect(result.itemsAffected).toBe(0);
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBeNull();
  });
});

describe('proposal_resolution batch bound', () => {
  it('decides only the configured number of rows in one run, oldest first', async () => {
    const first = seedContradiction('old-1', 'new-1', new Date(CREATED.getTime() - 60_000));
    const second = seedContradiction('old-2', 'new-2', CREATED);
    const driver = fakeDriver([
      ...PAIR,
      { id: 'old-2', label: 'Concept', text: 'Zephyr retries twice' },
      { id: 'new-2', label: 'Concept', text: 'Zephyr retries five times' },
    ]);
    const calls = new CallCount();
    const provider = judgingProvider({ first: STANDS, second: VETOES }, calls);
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, resolutionBatch: 1 },
    };

    const result = await proposalResolutionOperation().run(ctxFor(config, { driver, provider }));

    expect(result.itemsProcessed).toBe(1);
    expect(calls.count).toBe(2);
    expect(getSupersessionProposal(db, first)?.resolvedAt).toBe(NOW.toISOString());
    expect(getSupersessionProposal(db, second)?.resolvedAt).toBeNull();
  });
});
