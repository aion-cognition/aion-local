import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  intentionUpkeepLedgerKey,
  intentionUpkeepOperation,
  INTENTION_UPKEEP_OPERATION,
} from './intention-upkeep.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function contextWithSwitch(intentionUpkeep: boolean): OperationContext {
  return {
    driver: {
      executeQuery: () => {
        throw new Error('intention_upkeep queried the graph with the kill switch off');
      },
    } as unknown as Driver,
    db: undefined as unknown as SqliteHandle,
    config: { ...DEFAULTS, maintenance: { ...DEFAULTS.maintenance, intentionUpkeep } },
    logger: silentLogger(),
    provider: refusingProvider,
    health: healthFixture(),
    now: new Date('2026-09-05T00:00:00.000Z'),
    signal: new AbortController().signal,
  };
}

describe('intentionUpkeepOperation', () => {
  it('runs on the day bucket and declares no metric, since no snapshot counts intentions', () => {
    const operation = intentionUpkeepOperation();

    expect(operation.name).toBe(INTENTION_UPKEEP_OPERATION);
    expect(operation.bucket).toBe('day');
    expect(operation.measure).toBeUndefined();
  });

  it('is a candidate only while its kill switch is on', () => {
    const operation = intentionUpkeepOperation();

    expect(operation.enabled?.(DEFAULTS)).toBe(true);
    expect(
      operation.enabled?.({
        ...DEFAULTS,
        maintenance: { ...DEFAULTS.maintenance, intentionUpkeep: false },
      }),
    ).toBe(false);
  });

  it('reports a noop without touching the graph when the kill switch is off', async () => {
    const outcome = await intentionUpkeepOperation().run(contextWithSwitch(false));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail:
        'intention upkeep disabled by AION_MAINTENANCE_INTENTION_UPKEEP; no intentions examined',
    });
  });

  it('keys a ledger row per intention under a namespace of its own', () => {
    expect(intentionUpkeepLedgerKey('goal-1')).toBe('intention_upkeep:goal-1');
    expect(intentionUpkeepLedgerKey('goal-1')).not.toBe(intentionUpkeepLedgerKey('goal-2'));
  });
});
