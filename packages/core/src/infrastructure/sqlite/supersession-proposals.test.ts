import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import {
  findSupersessionProposalsForNode,
  getSupersessionProposal,
  listSupersessionProposals,
  recordSupersessionProposal,
  resolveSupersessionProposal,
} from './supersession-proposals.js';

describe('supersession proposal accessors', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-supersession-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function record(overrides: Partial<Parameters<typeof recordSupersessionProposal>[1]> = {}): string {
    return recordSupersessionProposal(store.db, {
      oldId: 'decision-old',
      newId: 'decision-new',
      confidence: 0.6,
      rationale: 'the new decision reverses the old one',
      episodeId: 'episode-2',
      createdAt: '2026-08-28T09:00:00.000Z',
      ...overrides,
    });
  }

  it('records a proposal open, with its rationale and episode', () => {
    const id = record();

    const proposal = getSupersessionProposal(store.db, id);
    expect(proposal).toEqual({
      id,
      oldId: 'decision-old',
      newId: 'decision-new',
      confidence: 0.6,
      rationale: 'the new decision reverses the old one',
      episodeId: 'episode-2',
      createdAt: '2026-08-28T09:00:00.000Z',
      resolvedAt: null,
    });
  });

  it('re-judging a pair updates the row rather than adding one', () => {
    const first = record({ confidence: 0.6 });
    const second = record({ confidence: 0.7, rationale: 'sharper reading', createdAt: '2026-09-01T00:00:00.000Z' });

    expect(second).toBe(first);
    expect(listSupersessionProposals(store.db)).toHaveLength(1);

    const proposal = getSupersessionProposal(store.db, first);
    expect(proposal?.confidence).toBe(0.7);
    expect(proposal?.rationale).toBe('sharper reading');
    // The first judgment's timestamp is when the substrate raised the question.
    expect(proposal?.createdAt).toBe('2026-08-28T09:00:00.000Z');
  });

  it('keeps a resolved proposal resolved when the pair is judged again', () => {
    const id = record();
    expect(resolveSupersessionProposal(store.db, id, '2026-08-29T00:00:00.000Z')).toBe(true);

    record({ confidence: 0.8 });
    expect(getSupersessionProposal(store.db, id)?.resolvedAt).toBe('2026-08-29T00:00:00.000Z');
  });

  it('resolves once', () => {
    const id = record();
    expect(resolveSupersessionProposal(store.db, id)).toBe(true);
    expect(resolveSupersessionProposal(store.db, id)).toBe(false);
    expect(resolveSupersessionProposal(store.db, 'missing')).toBe(false);
  });

  it('finds proposals from either end of the pair', () => {
    record();
    record({ oldId: 'decision-older', newId: 'decision-old' });

    expect(findSupersessionProposalsForNode(store.db, 'decision-old').map((row) => row.newId)).toEqual([
      'decision-new',
      'decision-old',
    ]);
    expect(findSupersessionProposalsForNode(store.db, 'unrelated')).toEqual([]);
  });

  it('lists proposals in insertion order', () => {
    record();
    record({ oldId: 'insight-old', newId: 'insight-new' });

    expect(listSupersessionProposals(store.db).map((row) => row.oldId)).toEqual([
      'decision-old',
      'insight-old',
    ]);
  });
});
