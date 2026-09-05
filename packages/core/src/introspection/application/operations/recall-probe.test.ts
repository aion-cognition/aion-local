import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  probeQuery,
  recallProbeLedgerKey,
  recallProbeOperation,
  RECALL_PROBE_IDENTITY,
  RECALL_PROBE_OPERATION,
} from './recall-probe.js';
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

function unreachableGraph(): Driver {
  return {
    executeQuery: () => {
      throw new Error('the probe queried the graph with no way to ask recall anything');
    },
  } as unknown as Driver;
}

function contextWithSwitch(recallProbe: boolean): OperationContext {
  return {
    driver: unreachableGraph(),
    db: undefined as unknown as SqliteHandle,
    config: { ...DEFAULTS, maintenance: { ...DEFAULTS.maintenance, recallProbe } },
    logger: silentLogger(),
    provider: refusingProvider,
    health: healthFixture(),
    now: new Date('2026-09-05T00:00:00.000Z'),
    signal: new AbortController().signal,
  };
}

describe('recallProbeOperation', () => {
  it('runs on the day bucket and declares no metric, since it measures rather than repairs', () => {
    const operation = recallProbeOperation();

    expect(operation.name).toBe(RECALL_PROBE_OPERATION);
    expect(operation.bucket).toBe('day');
    expect(operation.measure).toBeUndefined();
  });

  it('is a candidate only while its kill switch is on', () => {
    const operation = recallProbeOperation();

    expect(operation.enabled?.(DEFAULTS)).toBe(true);
    expect(
      operation.enabled?.({
        ...DEFAULTS,
        maintenance: { ...DEFAULTS.maintenance, recallProbe: false },
      }),
    ).toBe(false);
  });

  it('reports a noop without touching the graph when the kill switch is off', async () => {
    const outcome = await recallProbeOperation().run(contextWithSwitch(false));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'recall probe disabled by AION_MAINTENANCE_RECALL_PROBE; nothing asked',
    });
  });

  it('declines the run rather than asking through a recall it did not get', async () => {
    const outcome = await recallProbeOperation().run(contextWithSwitch(true));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'recall probe has no isolated recall to ask through; nothing asked',
    });
  });

  it('keys one ledger row per window under a namespace of its own', () => {
    expect(recallProbeLedgerKey('2026-09-05')).toBe('recall_probe:2026-09-05');
    expect(recallProbeLedgerKey('2026-09-05')).not.toBe(recallProbeLedgerKey('2026-09-06'));
  });

  it('names its session identity so a probe read is unmistakable in a log', () => {
    expect(RECALL_PROBE_IDENTITY).toBe('aion-recall-probe');
  });
});

describe('the probe query', () => {
  it('asks in the experience own words rather than composing a question', () => {
    expect(probeQuery({ observations: ['the WAL retry loop was the bug'] })).toBe(
      'the WAL retry loop was the bug',
    );
  });

  it('falls back to the first turn that said anything', () => {
    expect(
      probeQuery({
        turns: [
          { role: 'system', text: '   ' },
          { role: 'user', text: 'where did we land on the retry loop' },
        ],
      }),
    ).toBe('where did we land on the retry loop');
  });

  it('prefers an observation over a turn, since it is the distilled line', () => {
    expect(
      probeQuery({
        observations: ['the retry loop is fixed'],
        turns: [{ role: 'user', text: 'what about the retry loop' }],
      }),
    ).toBe('the retry loop is fixed');
  });

  it('clips a long experience to a query rather than sending a transcript', () => {
    const query = probeQuery({ observations: ['x'.repeat(900)] });

    expect(query).toHaveLength(400);
  });

  it('skips an episode of tool exhaust, which carries no words to ask back', () => {
    expect(probeQuery({ tool_executions: [{ tool: 'Bash', status: 'ok' }] })).toBeUndefined();
  });
});
