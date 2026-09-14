import { describe, expect, it } from 'vitest';

import {
  resonanceUsefulnessEvidence,
  summarizeResonanceUsefulness,
} from './resonance-usefulness-sense.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { appendResonanceServedEvent } from '../../../infrastructure/sqlite/sense-usage-events.js';
import {
  appendMemoryConfirmedEvent,
  appendReinforcementAppliedEvent,
  appendSelfReportEvent,
} from '../../../infrastructure/sqlite/usage-events.js';

/**
 * The resonance-usefulness distinction the acceptance list asks for directly: a genuine later
 * use or reversal reads differently from automatic exposure alone, and a served item nothing
 * later touches stays unknown rather than counted as unused.
 */

const T0 = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-01T01:00:00.000Z');
const EARLIER = new Date('2026-08-31T23:00:00.000Z');

function serve(db: SqliteHandle, itemId: string, occurredAt: Date, contested = false): void {
  appendResonanceServedEvent(db, {
    sessionId: 'session-1',
    itemId,
    method: 'resonance',
    contested,
    occurredAt,
  });
}

describe('summarizeResonanceUsefulness', () => {
  it('counts automatic exposure alone as unknown, never as unused', () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    serve(db, 'item-exposed-only', T0);

    const summary = summarizeResonanceUsefulness(db);

    expect(summary.served).toBe(1);
    expect(summary.laterReinforced).toBe(0);
    expect(summary.laterSelfReported).toBe(0);
    expect(summary.laterConfirmed).toBe(0);
    expect(summary.unknown).toBe(1);
    const line = resonanceUsefulnessEvidence(summary);
    expect(line).toContain('1 with no later record either way (unknown, not unused)');
    db.close();
  });

  it('counts a genuine later reinforcement, distinct from the emission that served it', () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    serve(db, 'item-a', T0);
    appendReinforcementAppliedEvent(db, {
      pairs: [{ sourceId: 'item-a', targetId: 'item-b', learningRate: 0.1 }],
      triggers: ['recall_pack_exposure'],
      weightFloor: 0.1,
      occurredAt: LATER,
    });

    const summary = summarizeResonanceUsefulness(db);

    expect(summary.served).toBe(1);
    expect(summary.laterReinforced).toBe(1);
    expect(summary.unknown).toBe(0);
    db.close();
  });

  it('does not count a reinforcement that happened before the serving as later use', () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    appendReinforcementAppliedEvent(db, {
      pairs: [{ sourceId: 'item-a', targetId: 'item-b', learningRate: 0.1 }],
      triggers: ['recall_pack_exposure'],
      weightFloor: 0.1,
      occurredAt: EARLIER,
    });
    serve(db, 'item-a', T0);

    const summary = summarizeResonanceUsefulness(db);

    expect(summary.laterReinforced).toBe(0);
    expect(summary.unknown).toBe(1);
    db.close();
  });

  it('counts a caller-reported memory_used and a memory_confirmed as their own distinct kinds', () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    serve(db, 'item-used', T0);
    serve(db, 'item-confirmed', T0);
    appendSelfReportEvent(db, 'memory_used', {
      key: 'report-1',
      sessionId: 'session-1',
      memories: ['item-used'],
      reporter: 'user',
      occurredAt: LATER,
    });
    appendMemoryConfirmedEvent(db, {
      key: 'confirm-1',
      episodeId: 'episode-1',
      memories: ['item-confirmed'],
      confirmedBy: 'user',
      evidence: 'said so in the next turn',
      occurredAt: LATER,
    });

    const summary = summarizeResonanceUsefulness(db);

    expect(summary.served).toBe(2);
    expect(summary.laterSelfReported).toBe(1);
    expect(summary.laterConfirmed).toBe(1);
    expect(summary.unknown).toBe(0);
    db.close();
  });

  it('a repeated exposure of the same item is not itself a use: it stays unknown without other evidence', () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    serve(db, 'item-repeated', T0);
    serve(db, 'item-repeated', LATER);

    const summary = summarizeResonanceUsefulness(db);

    expect(summary.served).toBe(2);
    expect(summary.laterReinforced).toBe(0);
    expect(summary.laterSelfReported).toBe(0);
    expect(summary.laterConfirmed).toBe(0);
    // The second serving is itself a later event, but it is exposure, not use; recorded as
    // served twice and never promoted into a use just because it recurred.
    expect(summary.unknown).toBe(2);
    db.close();
  });

  it('carries the contested marker recorded at serving, unaffected by later evidence', () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    serve(db, 'item-contested', T0, true);

    const summary = summarizeResonanceUsefulness(db);

    expect(summary.contested).toBe(1);
    db.close();
  });
});
