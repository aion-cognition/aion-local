import { describe, expect, it } from 'vitest';

import { LaneAssigner, type LaneAssignerOptions } from './lanes.js';

const LIMITS: LaneAssignerOptions = {
  arrivalWindowMs: 60_000,
  sessionArrivalMax: 10,
  globalArrivalMax: 20,
  hotSessionArrivalMax: 3,
};

const START = new Date('2026-08-28T00:00:00.000Z');

function at(offsetMs: number): Date {
  return new Date(START.getTime() + offsetMs);
}

function push(assigner: LaneAssigner, sessionId: string, count: number, from = 0): string[] {
  const lanes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    lanes.push(assigner.assign({ sessionId, now: at(from + index) }).lane);
  }
  return lanes;
}

describe('lane assignment', () => {
  it('defaults to interactive', () => {
    const assigner = new LaneAssigner(LIMITS);

    expect(assigner.assign({ sessionId: 'a', now: START })).toMatchObject({
      lane: 'interactive',
      reason: 'default',
    });
  });

  it('takes an explicit bulk flag at face value, however quiet the session is', () => {
    const assigner = new LaneAssigner(LIMITS);

    expect(assigner.assign({ sessionId: 'a', requested: 'bulk', now: START })).toMatchObject({
      lane: 'bulk',
      reason: 'requested',
    });
  });

  it('never promotes an explicit interactive flag past the backstop', () => {
    const assigner = new LaneAssigner(LIMITS);
    push(assigner, 'a', LIMITS.sessionArrivalMax);

    expect(
      assigner.assign({ sessionId: 'a', requested: 'interactive', now: at(50) }),
    ).toMatchObject({ lane: 'bulk', reason: 'session-rate' });
  });
});

describe('lane backstop, per session', () => {
  it('leaves a session-end flush at the threshold interactive', () => {
    const assigner = new LaneAssigner(LIMITS);

    expect(push(assigner, 'a', LIMITS.sessionArrivalMax)).not.toContain('bulk');
  });

  it('demotes the arrival past the threshold and every one after it', () => {
    const assigner = new LaneAssigner(LIMITS);
    const lanes = push(assigner, 'a', LIMITS.sessionArrivalMax + 3);

    expect(lanes.slice(0, LIMITS.sessionArrivalMax)).not.toContain('bulk');
    expect(lanes.slice(LIMITS.sessionArrivalMax)).toEqual(['bulk', 'bulk', 'bulk']);
  });

  it('leaves a quiet session interactive while a noisy one is demoted', () => {
    const assigner = new LaneAssigner(LIMITS);
    push(assigner, 'noisy', LIMITS.sessionArrivalMax + 1);

    expect(assigner.assign({ sessionId: 'quiet', now: at(100) }).lane).toBe('interactive');
  });

  // The window slides, so the demotion is not a latch: a client that stops flooding is back
  // in the interactive lane one window later without anything having to reset it.
  it('restores a session once its arrivals fall out of the window', () => {
    const assigner = new LaneAssigner(LIMITS);
    push(assigner, 'a', LIMITS.sessionArrivalMax + 1);

    expect(
      assigner.assign({ sessionId: 'a', now: at(LIMITS.arrivalWindowMs + 100) }),
    ).toMatchObject({
      lane: 'interactive',
      sessionArrivals: 1,
    });
  });
});

/**
 * The measured flood was eight fresh sessions, which is the pattern a per-session counter
 * cannot see: each session stays under its own threshold while the queue fills with days of
 * work. Past the global threshold every session's allowance drops to the hot one.
 */
describe('lane backstop, global rate', () => {
  it('demotes sessions that stay under their own threshold once the substrate is hot', () => {
    const assigner = new LaneAssigner(LIMITS);
    for (let session = 0; session < 7; session += 1) {
      push(assigner, `session-${String(session)}`, 3, session * 10);
    }

    expect(assigner.globalArrivals).toBe(21);
    expect(assigner.assign({ sessionId: 'session-8', now: at(200) })).toMatchObject({
      lane: 'interactive',
      reason: 'default',
    });
    expect(assigner.assign({ sessionId: 'session-8', now: at(201) }).lane).toBe('interactive');
    expect(assigner.assign({ sessionId: 'session-8', now: at(202) }).lane).toBe('interactive');
    expect(assigner.assign({ sessionId: 'session-8', now: at(203) })).toMatchObject({
      lane: 'bulk',
      reason: 'global-rate',
    });
  });

  // A session that pushes one episode during someone else's flood is exactly the caller the
  // freshness pin exists for; demoting it would hand the flood the starvation back.
  it('leaves a single arrival interactive even while the substrate is hot', () => {
    const assigner = new LaneAssigner(LIMITS);
    push(assigner, 'flood', LIMITS.globalArrivalMax + 1);

    expect(assigner.assign({ sessionId: 'innocent', now: at(500) })).toMatchObject({
      lane: 'interactive',
      reason: 'default',
    });
  });

  it('reports the counts its decision was made on', () => {
    const assigner = new LaneAssigner(LIMITS);
    push(assigner, 'a', 4);

    expect(assigner.assign({ sessionId: 'b', now: at(10) })).toMatchObject({
      sessionArrivals: 1,
      globalArrivals: 5,
    });
  });

  it('forgets a session that has gone quiet rather than growing without bound', () => {
    const assigner = new LaneAssigner(LIMITS);
    for (let session = 0; session < 50; session += 1) {
      push(assigner, `session-${String(session)}`, 1, session);
    }

    expect(assigner.globalArrivals).toBe(50);
    expect(
      assigner.assign({ sessionId: 'later', now: at(LIMITS.arrivalWindowMs + 100) }),
    ).toMatchObject({ globalArrivals: 1, lane: 'interactive' });
  });
});
