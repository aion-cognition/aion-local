import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { triggeredIntentions, type IntentionInput } from './intentions.js';
import type { ResonanceResult } from './resonance.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { asOf, knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { ActivatedNode } from '../domain/activation.js';
import { INTENTION_TRIGGER_METHOD } from '../domain/intention-triggers.js';

type FakeRow = Record<string, unknown>;

const NOW = new Date('2026-10-05T09:00:00.000Z');

const DUE = new Date('2026-10-01T00:00:00.000Z');

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

function failingDriver(): Driver {
  return {
    executeQuery: () => Promise.reject(new Error('graph unavailable')),
  } as unknown as Driver;
}

/** A row shaped the way `findTriggerableIntentions` reads one. */
function intentionRow(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    subject_entity_id: null,
    trigger_after: null,
    trigger_vec: null,
    ...overrides,
  };
}

/** A row shaped the way `nodeCandidates` reads one. */
function candidateRow(id: string, content = `content of ${id}`): FakeRow {
  return {
    id,
    labels: ['Goal', 'Memory', 'AionNode'],
    content,
    occurred_at: null,
    is_structural: null,
    source_episode_id: null,
    currency: 'current',
    superseded_by: null,
  };
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

const RESONANCE: ResonanceResult = { items: [], covered: 0, activated: 0 };

function input(overrides: Partial<IntentionInput> = {}): IntentionInput {
  return {
    activated: activated('entity-postgres'),
    resonance: RESONANCE,
    served: [],
    mode: withCurrency(NOW),
    now: NOW,
    ...overrides,
  };
}

function deps(
  driver: Driver,
  config: Config = DEFAULTS,
): Parameters<typeof triggeredIntentions>[0] {
  return { driver, config, logger: silentLogger() };
}

function readingIntentions(rows: readonly FakeRow[]): Driver {
  return answeringWith((cypher) =>
    cypher.includes('trigger_vec AS trigger_vec') ? rows : [candidateRow('goal-1')],
  );
}

describe('triggered intentions', () => {
  it('serves an intention whose subject the spread reached, explained by the trigger', async () => {
    const driver = readingIntentions([
      intentionRow('goal-1', { subject_entity_id: 'entity-postgres' }),
    ]);

    const result = await triggeredIntentions(deps(driver), input());

    expect(result.items.map((item) => item.id)).toEqual(['goal-1']);
    expect(result.items[0]?.rationale.method).toBe(INTENTION_TRIGGER_METHOD);
  });

  it('does not run at all when the kill switch is off', async () => {
    const config: Config = {
      ...DEFAULTS,
      recall: { ...DEFAULTS.recall, intentionTriggers: false },
    };

    const result = await triggeredIntentions(deps(unreachableDriver(), config), input());

    expect(result).toEqual({ items: [], skipped: 'disabled' });
  });

  /**
   * Asking what the substrate held last month is a question about the past. A trigger is the
   * substrate acting now, so a historical vantage point evaluates none of them, the way the
   * repeat and own-session subtractions are also exempt from a time-traveled read.
   */
  it('evaluates no trigger on a time-traveled read, on either timeline', async () => {
    const asOfResult = await triggeredIntentions(
      deps(unreachableDriver()),
      input({ mode: asOf(new Date('2026-08-01T00:00:00.000Z')) }),
    );
    const knewAtResult = await triggeredIntentions(
      deps(unreachableDriver()),
      input({ mode: knewAt(new Date('2026-08-01T00:00:00.000Z')) }),
    );

    expect(asOfResult).toEqual({ items: [], skipped: 'time_travel' });
    expect(knewAtResult).toEqual({ items: [], skipped: 'time_travel' });
  });

  it('says a substrate holding no triggerable intention apart from one that was not due', async () => {
    const empty = await triggeredIntentions(deps(readingIntentions([])), input());
    const notDue = await triggeredIntentions(
      deps(readingIntentions([intentionRow('goal-1', { subject_entity_id: 'entity-other' })])),
      input(),
    );

    expect(empty.skipped).toBe('none_open');
    expect(notDue.skipped).toBe('no_trigger');
  });

  /**
   * The situation trigger is the only one that needs the centroid, and the second pass declines
   * to build one whenever the query anchored nothing. The other two still fire.
   */
  it('fires a temporal trigger on a run whose resonance produced no centroid', async () => {
    const driver = readingIntentions([intentionRow('goal-1', { trigger_after: DUE })]);

    const result = await triggeredIntentions(
      deps(driver),
      input({ resonance: { items: [], skipped: 'no_anchor', covered: 0, activated: 0 } }),
    );

    expect(result.items.map((item) => item.id)).toEqual(['goal-1']);
    expect(result.items[0]?.rationale.path).toContain('date');
  });

  it('costs the pack its intentions and nothing else when the read fails', async () => {
    const result = await triggeredIntentions(deps(failingDriver()), input());

    expect(result).toEqual({ items: [], skipped: 'unavailable' });
  });
});
