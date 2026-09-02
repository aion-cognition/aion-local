import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  EDGE_PRUNE_RELEVANCE_DIVISOR,
  edgePruneOperation,
  edgePruneRelevance,
} from './edge-prune.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { NEUTRAL_GRAPH_HEALTH } from '../../domain/health.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

describe('edgePruneRelevance', () => {
  it('is zero on a graph with no at-floor association edge, however many others it carries', () => {
    const health = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, decayableEdges: 9_000, atFloorAssociationEdges: 0 },
    });
    expect(edgePruneRelevance(health)).toBe(0);
  });

  it('scales on the at-floor count and holds at one past the divisor', () => {
    const some = healthFixture({
      graph: {
        ...NEUTRAL_GRAPH_HEALTH,
        atFloorAssociationEdges: EDGE_PRUNE_RELEVANCE_DIVISOR / 4,
      },
    });
    expect(edgePruneRelevance(some)).toBeCloseTo(0.25, 6);

    const flooded = healthFixture({
      graph: {
        ...NEUTRAL_GRAPH_HEALTH,
        atFloorAssociationEdges: EDGE_PRUNE_RELEVANCE_DIVISOR * 9,
      },
    });
    expect(edgePruneRelevance(flooded)).toBe(1);
  });
});

describe('edgePruneOperation, run directly rather than through the engine', () => {
  it('reports a noop without touching the graph when the kill switch is off', async () => {
    const ctx: OperationContext = {
      driver: {
        executeQuery: () => {
          throw new Error('edge_prune queried the graph with the kill switch off');
        },
      } as unknown as Driver,
      db: undefined as unknown as SqliteHandle,
      config: { ...DEFAULTS, maintenance: { ...DEFAULTS.maintenance, edgePrune: false } },
      logger: silentLogger(),
      provider: refusingProvider,
      health: healthFixture(),
      now: new Date('2026-08-31T00:00:00.000Z'),
      signal: new AbortController().signal,
    };

    const outcome = await edgePruneOperation().run(ctx);
    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'edge pruning disabled by AION_MAINTENANCE_EDGE_PRUNE; no edges examined',
    });
  });
});
