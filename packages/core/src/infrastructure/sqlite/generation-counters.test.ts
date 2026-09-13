import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  GENERATION_COUNTER_PROVIDERS,
  GENERATION_COUNTER_ROLES,
  generationCounters,
  recordGenerationOutcome,
  type GenerationCounterProvider,
} from './generation-counters.js';
import type { GenerationEvent } from '../providers/role-provider.js';
import { GENERATION_ROLES } from '../providers/routing.js';

/**
 * A key for every provider the router can route to. Written as a record over the router's own
 * union so a new provider fails this file at typecheck rather than counting nothing forever.
 */
const ROUTABLE: Readonly<Record<GenerationEvent['provider'], GenerationCounterProvider>> = {
  anthropic: 'anthropic',
};

describe('generation counters', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-generation-counters-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keys a row for every route the router can take', () => {
    expect([...GENERATION_COUNTER_ROLES]).toEqual([...GENERATION_ROLES]);
    expect([...GENERATION_COUNTER_PROVIDERS].sort()).toEqual(Object.values(ROUTABLE).sort());
    expect(generationCounters(store.db).routes).toHaveLength(
      GENERATION_ROLES.length * GENERATION_COUNTER_PROVIDERS.length,
    );
  });

  it('reports an unused substrate as unmeasured rather than as a route failing nothing', () => {
    const counters = generationCounters(store.db);

    expect(counters.calls).toBe(0);
    expect(counters.failureRate).toBeUndefined();
    for (const route of counters.routes) {
      expect(route.calls).toBe(0);
      expect(route.failureRate).toBeUndefined();
      expect(route.meanDurationMs).toBeUndefined();
    }
  });

  it('takes what the router already reports about a generation', () => {
    // The router's own event shape, so the callback that writes these needs no translation.
    const event: GenerationEvent = {
      role: 'cue',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      durationMs: 400,
      ok: true,
    };

    recordGenerationOutcome(store.db, event);

    const route = generationCounters(store.db).routes.find((candidate) => candidate.role === 'cue');
    expect(route).toMatchObject({ calls: 1, failed: 0, failureRate: 0, meanDurationMs: 400 });
  });

  it('separates one role failing from another role working', () => {
    recordGenerationOutcome(store.db, {
      role: 'reflect',
      provider: 'anthropic',
      ok: false,
      durationMs: 900,
    });
    recordGenerationOutcome(store.db, {
      role: 'reflect',
      provider: 'anthropic',
      ok: false,
      durationMs: 1_100,
    });
    recordGenerationOutcome(store.db, {
      role: 'cue',
      provider: 'anthropic',
      ok: true,
      durationMs: 200,
    });

    const counters = generationCounters(store.db);
    const reflect = counters.routes.find((route) => route.role === 'reflect');
    const cue = counters.routes.find((route) => route.role === 'cue');

    expect(reflect).toMatchObject({ calls: 2, failed: 2, failureRate: 1, meanDurationMs: 1_000 });
    expect(cue).toMatchObject({ calls: 1, failed: 0, failureRate: 0 });
    // The headline is the whole substrate's rate, which is what a health snapshot reads.
    expect(counters.calls).toBe(3);
    expect(counters.failed).toBe(2);
    expect(counters.failureRate).toBeCloseTo(2 / 3, 10);
  });

  it('times a failed call too, since a route that hangs costs what it costs', () => {
    recordGenerationOutcome(store.db, {
      role: 'cue',
      provider: 'anthropic',
      ok: false,
      durationMs: 30_000,
    });

    const route = generationCounters(store.db).routes.find((candidate) => candidate.role === 'cue');
    expect(route?.meanDurationMs).toBe(30_000);
  });

  it('accumulates across calls rather than resetting to the last one', () => {
    for (let call = 0; call < 4; call += 1) {
      recordGenerationOutcome(store.db, {
        role: 'reflect',
        provider: 'anthropic',
        ok: call > 0,
        durationMs: 100,
      });
    }

    const counters = generationCounters(store.db);
    expect(counters.calls).toBe(4);
    expect(counters.failureRate).toBe(0.25);
  });
});
