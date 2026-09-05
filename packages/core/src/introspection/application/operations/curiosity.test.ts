import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  curiosityLedgerKey,
  curiosityOperation,
  CURIOSITY_ASPECT,
  CURIOSITY_OPERATION,
  fallbackQuestion,
} from './curiosity.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { foldAspect } from '../../../reflection/domain/claim-key.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function unreachableGraph(): Driver {
  return {
    executeQuery: () => {
      throw new Error('curiosity queried the graph with nothing to record a question through');
    },
  } as unknown as Driver;
}

function contextWithSwitch(curiosity: boolean): OperationContext {
  return {
    driver: unreachableGraph(),
    db: undefined as unknown as SqliteHandle,
    config: { ...DEFAULTS, maintenance: { ...DEFAULTS.maintenance, curiosity } },
    logger: silentLogger(),
    provider: refusingProvider,
    health: healthFixture(),
    now: new Date('2026-09-05T00:00:00.000Z'),
    signal: new AbortController().signal,
  };
}

describe('curiosityOperation', () => {
  it('runs on the day bucket and declares no metric, since no snapshot counts open questions', () => {
    const operation = curiosityOperation();

    expect(operation.name).toBe(CURIOSITY_OPERATION);
    expect(operation.bucket).toBe('day');
    expect(operation.measure).toBeUndefined();
  });

  it('is a candidate only while its kill switch is on', () => {
    const operation = curiosityOperation();

    expect(operation.enabled?.(DEFAULTS)).toBe(true);
    expect(
      operation.enabled?.({
        ...DEFAULTS,
        maintenance: { ...DEFAULTS.maintenance, curiosity: false },
      }),
    ).toBe(false);
  });

  it('reports a noop without touching the graph when the kill switch is off', async () => {
    const outcome = await curiosityOperation().run(contextWithSwitch(false));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'curiosity disabled by AION_MAINTENANCE_CURIOSITY; no entity examined',
    });
  });

  it('declines the run rather than selecting entities it has no way to ask about', async () => {
    const outcome = await curiosityOperation().run(contextWithSwitch(true));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'curiosity has no intake path to record a question through; no entity examined',
    });
  });

  it('keys a ledger row per entity under a namespace of its own', () => {
    expect(curiosityLedgerKey('entity-1')).toBe('curiosity:entity-1');
    expect(curiosityLedgerKey('entity-1')).not.toBe(curiosityLedgerKey('entity-2'));
  });

  it('names the entity in the question it falls back to, since a later session gets one line', () => {
    const question = fallbackQuestion({ name: 'Quillon' });

    expect(question).toContain('Quillon');
    expect(question.endsWith('?')).toBe(true);
  });

  it('holds an aspect the fold leaves alone, so a later intention keys against the same slot', () => {
    expect(foldAspect(CURIOSITY_ASPECT)).toBe(CURIOSITY_ASPECT);
  });
});
