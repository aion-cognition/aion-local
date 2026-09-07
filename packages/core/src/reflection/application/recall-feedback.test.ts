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

function record(feedback: RecallFeedback, sessionId = SESSION, now = NOW): void {
  recordRecallFeedback(deps, {
    feedback: redactFeedback(deps, feedback, THRESHOLD),
    sessionId,
    now,
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
    record(feedback, SESSION, new Date('2026-09-07T09:00:00.000Z'));

    expect(stream()).toHaveLength(1);
  });

  it('takes the same words from another session as its own signal', () => {
    const feedback: RecallFeedback = {
      used: [{ memories: ['node-a'], reporter: 'the calling agent' }],
    };

    record(feedback);
    record(feedback, 'session-2');

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
    recordRecallFeedback(deps, { feedback: undefined, sessionId: SESSION, now: NOW });

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
});
