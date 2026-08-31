import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  IDENTIFIER_DECAY_STANDING_RELEVANCE,
  identifierDecayOperation,
  identifierDecayRelevance,
} from './identifier-decay.js';
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

describe('identifierDecayRelevance', () => {
  it('is zero on an empty substrate, however long the wait', () => {
    const health = healthFixture({ graph: { ...NEUTRAL_GRAPH_HEALTH, nodes: 0 } });
    expect(identifierDecayRelevance(health)).toBe(0);
  });

  it('holds the standing value once the graph carries any node at all', () => {
    const health = healthFixture({ graph: { ...NEUTRAL_GRAPH_HEALTH, nodes: 1 } });
    expect(identifierDecayRelevance(health)).toBe(IDENTIFIER_DECAY_STANDING_RELEVANCE);

    const busy = healthFixture({ graph: { ...NEUTRAL_GRAPH_HEALTH, nodes: 9_000 } });
    expect(identifierDecayRelevance(busy)).toBe(IDENTIFIER_DECAY_STANDING_RELEVANCE);
  });
});

describe('identifierDecayOperation, run directly rather than through the engine', () => {
  it('reports a noop without touching the graph when the kill switch is off', async () => {
    const ctx: OperationContext = {
      driver: {
        executeQuery: () => {
          throw new Error('identifier_decay queried the graph with the kill switch off');
        },
      } as unknown as Driver,
      db: undefined as unknown as SqliteHandle,
      config: { ...DEFAULTS, maintenance: { ...DEFAULTS.maintenance, identifierDecay: false } },
      logger: silentLogger(),
      provider: refusingProvider,
      health: healthFixture(),
      now: new Date('2026-08-31T00:00:00.000Z'),
      signal: new AbortController().signal,
    };

    const outcome = await identifierDecayOperation().run(ctx);
    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail:
        'identifier decay disabled by AION_MAINTENANCE_IDENTIFIER_DECAY; no entities examined',
    });
  });
});
