import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { resonate, type ResonanceInput } from './resonance.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { ActivatedNode } from '../domain/activation.js';
import { RESONANCE_PATH } from '../domain/resonance.js';

type FakeRow = Record<string, unknown>;

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function answeringWith(rows: (cypher: string) => readonly FakeRow[]): Driver {
  return {
    executeQuery: (cypher: string) =>
      Promise.resolve({
        records: rows(cypher).map((row) => ({ toObject: () => row })),
        summary: { counters: { updates: () => ({}) } },
      }),
  } as unknown as Driver;
}

/** Any driver call is a failure of the test, not of the code: a skip must cost no round trip. */
function unreachableDriver(): Driver {
  return {
    executeQuery: () => {
      throw new Error('the stage queried the graph on a path that should have skipped');
    },
  } as unknown as Driver;
}

function activated(...ids: readonly string[]): readonly ActivatedNode[] {
  return ids.map((nodeId, index) => ({
    nodeId,
    score: 1 - index * 0.1,
    hops: index,
    pathSummary: '(seed)',
    currency: { currency: 'current' },
    isStructural: false,
  }));
}

function input(overrides: Partial<ResonanceInput> = {}): ResonanceInput {
  return {
    activated: activated('a', 'b'),
    exclude: new Set(['a', 'b']),
    anchoredIds: new Set(['a', 'b']),
    mode: withCurrency(),
    ...overrides,
  };
}

function deps(driver: Driver, config: Config = DEFAULTS): Parameters<typeof resonate>[0] {
  return { driver, config, logger: silentLogger() };
}

/** A row shaped the way `contextVectors` reads one. */
function contextVectorRow(id: string, vector: readonly number[]): FakeRow {
  return { id, vector: [...vector] };
}

/** A row shaped the way `resonantNodes` reads one. */
function hitRow(id: string, similarity: number): FakeRow {
  return { id, similarity };
}

/** A row shaped the way `nodeCandidates` reads one. */
function candidateRow(id: string, content = `content of ${id}`): FakeRow {
  return {
    id,
    labels: ['Episode', 'Memory', 'AionNode'],
    content,
    occurred_at: null,
    is_structural: null,
    source_episode_id: null,
    currency: 'current',
    superseded_by: null,
  };
}

function routed(cypher: string): 'context-vectors' | 'search' | 'hydrate' {
  if (cypher.includes('db.index.vector.queryNodes')) {
    return 'search';
  }
  if (cypher.includes('context_vec AS vector')) {
    return 'context-vectors';
  }
  return 'hydrate';
}

describe('context resonance when it declines to search', () => {
  it('does not run at all when the setting is off', async () => {
    const config: Config = {
      ...DEFAULTS,
      recall: { ...DEFAULTS.recall, useContextResonance: false },
    };

    const result = await resonate(deps(unreachableDriver(), config), input());

    expect(result.skipped).toBe('disabled');
    expect(result.items).toEqual([]);
  });

  it('has nothing to average when the spread activated nothing', async () => {
    const result = await resonate(deps(unreachableDriver()), input({ activated: [] }));

    expect(result.skipped).toBe('no_activation');
    expect(result.activated).toBe(0);
  });

  // The centroid is the shape of what the query found. When the gate admitted nothing on its
  // own evidence there is no such shape, and searching from one anyway is how an off-topic
  // pack fills itself.
  it('declines a query the first pass could not anchor', async () => {
    const result = await resonate(deps(unreachableDriver()), input({ anchoredIds: new Set() }));

    expect(result.skipped).toBe('no_anchor');
    expect(result.items).toEqual([]);
  });

  it('skips a cold substrate whose activated nodes carry no context vector yet', async () => {
    const result = await resonate(
      deps(answeringWith((cypher) => (routed(cypher) === 'context-vectors' ? [] : []))),
      input(),
    );

    expect(result.skipped).toBe('no_context_vectors');
    expect(result.covered).toBe(0);
    expect(result.activated).toBe(2);
  });

  it('keeps the pack when the graph fails underneath it', async () => {
    const failing = {
      executeQuery: () => Promise.reject(new Error('ServiceUnavailable: connect ECONNREFUSED')),
    } as unknown as Driver;

    const result = await resonate(deps(failing), input());

    expect(result.skipped).toBe('unavailable');
    expect(result.items).toEqual([]);
  });
});

describe('context resonance when it searches', () => {
  function searchingDriver(hits: readonly FakeRow[], candidates: readonly FakeRow[]): Driver {
    return answeringWith((cypher) => {
      const target = routed(cypher);
      if (target === 'context-vectors') {
        return [contextVectorRow('a', [1, 0]), contextVectorRow('b', [0, 1])];
      }
      if (target === 'search') {
        return hits;
      }
      return candidates;
    });
  }

  it('returns each hit at its own context similarity, explained as resonance', async () => {
    const result = await resonate(
      deps(searchingDriver([hitRow('r1', 0.84)], [candidateRow('r1')])),
      input(),
    );

    expect(result.skipped).toBeUndefined();
    expect(result.covered).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.rationale).toEqual({
      method: 'resonance',
      score: 0.84,
      path: RESONANCE_PATH,
    });
    expect(result.items[0]?.measured).toBe(0.84);
  });

  it('keeps the search order rather than the order the hydration read answered in', async () => {
    const result = await resonate(
      deps(
        searchingDriver(
          [hitRow('r1', 0.9), hitRow('r2', 0.75)],
          [candidateRow('r2'), candidateRow('r1')],
        ),
      ),
      input(),
    );

    expect(result.items.map((item) => item.id)).toEqual(['r1', 'r2']);
  });

  it('averages only the activated nodes the first pass admitted', async () => {
    const asked: string[] = [];
    const driver = answeringWith((cypher) => {
      const target = routed(cypher);
      if (target === 'context-vectors') {
        return [contextVectorRow('a', [1, 0])];
      }
      if (target === 'search') {
        return [hitRow('r1', 0.9)];
      }
      return [candidateRow('r1')];
    });
    const recording = {
      executeQuery: (cypher: string, parameters: Record<string, unknown>) => {
        if (routed(cypher) === 'context-vectors') {
          asked.push(...(parameters.ids as string[]));
        }
        return (driver as unknown as { executeQuery: (c: string) => unknown }).executeQuery(cypher);
      },
    } as unknown as Driver;

    await resonate(
      deps(recording),
      input({ activated: activated('a', 'b', 'c'), anchoredIds: new Set(['a']) }),
    );

    // 'b' and 'c' were reached, not admitted. Averaging them in is what walks the centroid
    // toward the middle of the substrate, where the busiest nodes sit close to everything.
    expect(asked).toEqual(['a']);
  });

  it('returns no more resonant hits than the first pass admitted items', async () => {
    const limits: number[] = [];
    const driver = answeringWith((cypher) => {
      const target = routed(cypher);
      if (target === 'context-vectors') {
        return [contextVectorRow('a', [1, 0])];
      }
      if (target === 'search') {
        return [hitRow('r1', 0.9)];
      }
      return [candidateRow('r1')];
    });
    const recording = {
      executeQuery: (cypher: string, parameters: Record<string, unknown>) => {
        if (routed(cypher) === 'search') {
          limits.push(
            Number(
              (parameters.limit as { toNumber?: () => number }).toNumber?.() ?? parameters.limit,
            ),
          );
        }
        return (driver as unknown as { executeQuery: (c: string) => unknown }).executeQuery(cypher);
      },
    } as unknown as Driver;

    await resonate(deps(recording), input({ anchoredIds: new Set(['a']) }));

    expect(limits).toEqual([1]);
    expect(DEFAULTS.contextResonance.resonantLimit).toBeGreaterThan(1);
  });

  it('drops a hit the hydration read would not return, and one with nothing to render', async () => {
    const result = await resonate(
      deps(
        searchingDriver(
          [hitRow('forgotten', 0.9), hitRow('contentless', 0.85), hitRow('r1', 0.8)],
          [candidateRow('contentless', '  '), candidateRow('r1')],
        ),
      ),
      input(),
    );

    expect(result.items.map((item) => item.id)).toEqual(['r1']);
  });
});
