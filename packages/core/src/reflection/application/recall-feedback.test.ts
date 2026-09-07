import type { RecallFeedback } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordConfirmationFeedback,
  recordRecallFeedback,
  redactFeedback,
  type FeedbackDeps,
} from './recall-feedback.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  listUsageEventsAfter,
  type UsageEventRow,
} from '../../infrastructure/sqlite/usage-events.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const SESSION = 'session-1';
const EPISODE = 'episode-1';
const THRESHOLD = DEFAULTS.redaction.entropyThreshold;

let dir: string;
let store: SqliteStore;
let deps: FeedbackDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-recall-feedback-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  deps = {
    db: store.db,
    logger: openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' }),
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(
  feedback: RecallFeedback,
  overrides: { sessionId?: string; episodeId?: string; now?: Date } = {},
): void {
  recordRecallFeedback(deps, {
    feedback: redactFeedback(deps, feedback, THRESHOLD),
    sessionId: overrides.sessionId ?? SESSION,
    episodeId: overrides.episodeId ?? EPISODE,
    now: overrides.now ?? NOW,
  });
}

function stream(): readonly UsageEventRow[] {
  return listUsageEventsAfter(store.db, undefined, 20);
}

describe('what a caller states about a pack it was served', () => {
  it('records receipt and use as two signals rather than one', () => {
    record({
      received: [{ memories: ['node-a', 'node-b'], reporter: 'the calling agent' }],
      used: [{ memories: ['node-a'], reporter: 'the calling agent', evidence: 'turn 12' }],
    });

    expect(stream().map((event) => event.kind)).toEqual(['delivery_acknowledged', 'memory_used']);
    expect(stream()[1]?.payload).toEqual({
      sessionId: SESSION,
      memories: ['node-a'],
      reporter: 'the calling agent',
      evidence: 'turn 12',
    });
  });

  /**
   * A client retrying a push states the same thing again under a fresh clock, and two rows for
   * one statement would read as two reports.
   */
  it('records a repeated statement once, whatever clock the repeat arrives under', () => {
    const feedback: RecallFeedback = {
      used: [{ memories: ['node-a'], reporter: 'the calling agent' }],
    };

    record(feedback);
    record(feedback);
    record(feedback, { now: new Date('2026-09-07T09:00:00.000Z') });

    expect(stream()).toHaveLength(1);
  });

  /**
   * Using a memory at noon and again at one are two occurrences, and the caller is the only one
   * who can say so. Both are retried under a later clock, which is the arrival time and not the
   * occurrence, so the retries fold and the two occurrences stand.
   */
  it('keeps two stated occurrence times apart while folding a retry of each', () => {
    for (const occurredAt of ['2026-09-06T12:00:00.000Z', '2026-09-06T13:00:00.000Z']) {
      const feedback: RecallFeedback = {
        used: [{ memories: ['node-a'], reporter: 'the calling agent', occurred_at: occurredAt }],
      };
      record(feedback);
      record(feedback, { now: new Date('2026-09-07T09:00:00.000Z') });
    }

    expect(stream().map((event) => event.occurredAt)).toEqual([
      '2026-09-06T12:00:00.000Z',
      '2026-09-06T13:00:00.000Z',
    ]);
  });

  /**
   * With no stated time there is no occurrence to identify, so the experience carrying the report
   * stands in for one: a re-push resolves to the same episode and folds, and a later experience
   * saying the same thing is the caller reporting again.
   */
  it('reads the same wordless report on a later experience as a second report', () => {
    const feedback: RecallFeedback = {
      used: [{ memories: ['node-a'], reporter: 'the calling agent' }],
    };

    record(feedback);
    record(feedback, { episodeId: 'episode-2' });

    expect(stream()).toHaveLength(2);
  });

  /** A named occurrence is the caller's own identity for it, so which experience carried it changes nothing. */
  it('folds one stated occurrence reported across two experiences', () => {
    const feedback: RecallFeedback = {
      used: [
        {
          memories: ['node-a'],
          reporter: 'the calling agent',
          occurred_at: '2026-09-06T12:00:00.000Z',
        },
      ],
    };

    record(feedback);
    record(feedback, { episodeId: 'episode-2' });

    expect(stream()).toHaveLength(1);
  });

  it('takes the same words from another session as its own signal', () => {
    const feedback: RecallFeedback = {
      used: [{ memories: ['node-a'], reporter: 'the calling agent' }],
    };

    record(feedback);
    record(feedback, { sessionId: 'session-2' });

    expect(stream().map((event) => (event.payload as { sessionId: string }).sessionId)).toEqual([
      SESSION,
      'session-2',
    ]);
  });

  it('dates a report to the moment it named rather than to the call that carried it', () => {
    record({
      used: [
        {
          memories: ['node-a'],
          reporter: 'the calling agent',
          occurred_at: '2026-09-05T08:00:00.000Z',
        },
      ],
    });

    expect(stream()[0]?.occurredAt).toBe('2026-09-05T08:00:00.000Z');
  });

  it('redacts a secret out of the free text before it is stored', () => {
    record({
      used: [
        {
          memories: ['node-a'],
          reporter: 'agent AKIAIOSFODNN7EXAMPLE',
          evidence: 'pasted ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
        },
      ],
    });

    const payload = stream()[0]?.payload as { reporter: string; evidence: string };
    expect(payload.reporter).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(payload.reporter).toContain('⟨secret:aws-access-key:');
    expect(payload.evidence).toContain('⟨secret:github-token:');
  });

  it('writes nothing for a call that stated no feedback', () => {
    recordRecallFeedback(deps, {
      feedback: undefined,
      sessionId: SESSION,
      episodeId: EPISODE,
      now: NOW,
    });

    expect(stream()).toEqual([]);
  });
});

describe('a confirmation mirrored into the stream', () => {
  const CONFIRMATION = {
    target: 'node-a',
    by: 'Ryan Huber',
    evidence: 'review thread 41',
    at: NOW,
  };

  it('carries the confirmer and the reference that makes the record attributable', () => {
    recordConfirmationFeedback(deps, 'episode-1', [CONFIRMATION]);

    expect(stream()[0]).toMatchObject({
      kind: 'memory_confirmed',
      payload: {
        episodeId: 'episode-1',
        memories: ['node-a'],
        confirmedBy: 'Ryan Huber',
        evidence: 'review thread 41',
      },
    });
  });

  it('records one row however many times the same experience re-states it', () => {
    recordConfirmationFeedback(deps, 'episode-1', [CONFIRMATION]);
    recordConfirmationFeedback(deps, 'episode-1', [{ ...CONFIRMATION, at: new Date() }]);

    expect(stream()).toHaveLength(1);
  });

  it('reads a second experience confirming the same memory as a second confirmation', () => {
    recordConfirmationFeedback(deps, 'episode-1', [CONFIRMATION]);
    recordConfirmationFeedback(deps, 'episode-2', [CONFIRMATION]);

    expect(stream()).toHaveLength(2);
  });

  /**
   * A settle acknowledges the references it wrote, and a swallowed failure here would let it
   * acknowledge one it never recorded. The caller's retry is the repair, so the failure has to
   * reach it.
   */
  it('throws rather than losing a confirmation the stream refused', () => {
    store.db.exec(
      `CREATE TRIGGER refuse_confirmation BEFORE INSERT ON usage_events
       WHEN NEW.kind = 'memory_confirmed'
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );

    expect(() => {
      recordConfirmationFeedback(deps, 'episode-1', [CONFIRMATION]);
    }).toThrow();
    expect(stream()).toEqual([]);
  });
});
