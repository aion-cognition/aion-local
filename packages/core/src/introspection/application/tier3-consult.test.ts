import { describe, expect, it } from 'vitest';

import { consultTier3, type Tier3ConsultDeps, type Tier3ConsultInput } from './tier3-consult.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { recentModelLessons } from '../../infrastructure/sqlite/introspection-model-lessons.js';
import type { OperationCandidate } from '../domain/decide.js';
import { NEUTRAL_QUEUE_HEALTH } from '../domain/health.js';
import type { IntrospectionOperation } from '../domain/operation.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';
import type { Tier3Advisor } from '../domain/tier3.js';

/**
 * The lesson writer's persistence half: the model may attach a lesson to any answer that
 * resolved, it lands in `introspection_model_lessons` distinct from the deterministic insight
 * ledger, and a later read (`recentModelLessons`, what `tier3-evidence.ts` feeds back into the
 * next request as `Tier3Request.lessons`) can see it. No live model anywhere in this file.
 */

const CANDIDATES: readonly OperationCandidate[] = [
  { name: 'dead_letter', relevance: 0.18 },
  { name: 'memory_decay', relevance: 0.15 },
];

const LOGGER = openLogger({ filePath: '/dev/null', level: 'error' });

function baseInput(overrides: Partial<Tier3ConsultInput> = {}): Tier3ConsultInput {
  return {
    health: healthFixture({ queue: { ...NEUTRAL_QUEUE_HEALTH, exhausted: 9 } }),
    candidates: CANDIDATES,
    reason: 'no operation cleared the urgency threshold',
    cycle: 1,
    insights: [],
    senseEvidence: ['bridge traversal: 1 bridge(s) observed in a recall walk'],
    lessons: [],
    ...overrides,
  };
}

function deps(db: SqliteHandle, advisor: Tier3Advisor): Tier3ConsultDeps {
  return {
    db,
    config: DEFAULTS,
    logger: LOGGER,
    advisor,
    operations: [],
    signal: new AbortController().signal,
    act: () => {
      throw new Error('this scenario must never accept and run an operation');
    },
  };
}

describe('consultTier3 persists a lesson the model volunteers', () => {
  it('persists a lesson attached to a decline, filed under operation "none"', async () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    const advisor: Tier3Advisor = () =>
      Promise.resolve({
        status: 'declined',
        rationale: 'every backlog is small',
        lesson: 'dead_letter has never once needed a run this quarter',
      });

    await consultTier3(deps(db, advisor), baseInput());

    const lessons = recentModelLessons(db, 10);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      cycle: 1,
      operation: 'none',
      lesson: 'dead_letter has never once needed a run this quarter',
    });
    db.close();
  });

  it('persists a lesson attached to an advised operation, filed under that operation', async () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    const advisor: Tier3Advisor = () =>
      Promise.resolve({
        status: 'advised',
        proposal: { operation: 'dead_letter', confidence: 0.9, rationale: 'the queue is stuck' },
        lesson: 'this backlog tends to clear itself within a cycle once flagged',
      });

    await consultTier3(
      deps(db, advisor),
      baseInput({ candidates: [{ name: 'dead_letter', relevance: 0.9 }] }),
    );

    const lessons = recentModelLessons(db, 10);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ operation: 'dead_letter' });
    db.close();
  });

  it('reaches a later prompt: a lesson recorded on cycle 1 reads back for a later cycle', async () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    const advisor: Tier3Advisor = () =>
      Promise.resolve({
        status: 'declined',
        rationale: 'nothing to do',
        lesson: 'orphan share keeps drifting up between cycles even when nothing else changes',
      });

    await consultTier3(deps(db, advisor), baseInput({ cycle: 1 }));

    // The read `tier3-evidence.ts` does on the next cycle: oldest first, formatted for the prompt.
    const lessons = recentModelLessons(db, DEFAULTS.maintenance.tier3InsightCount).map(
      (entry) => `${entry.recordedAt}: ${entry.operation} ${entry.lesson}`,
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toContain('orphan share keeps drifting up');
    db.close();
  });

  it('writes nothing when the model declines to draw a lesson', async () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    const advisor: Tier3Advisor = () =>
      Promise.resolve({ status: 'declined', rationale: 'nothing to do' });

    await consultTier3(deps(db, advisor), baseInput());

    expect(recentModelLessons(db, 10)).toEqual([]);
    db.close();
  });

  it('writes nothing on a failed or unusable call: there is no answer to interpret', async () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    const advisor: Tier3Advisor = () => Promise.resolve({ status: 'failed', reason: 'timed out' });

    await consultTier3(deps(db, advisor), baseInput());

    expect(recentModelLessons(db, 10)).toEqual([]);
    db.close();
  });

  it('the acceptance gate ignores sense evidence: a fixed advisor answer runs the same operation whether evidence is rich or empty', async () => {
    const runs: string[] = [];
    const advisor: Tier3Advisor = () =>
      Promise.resolve({
        status: 'advised',
        proposal: { operation: 'dead_letter', confidence: 0.9, rationale: 'the queue is stuck' },
      });
    const candidates: readonly OperationCandidate[] = [{ name: 'dead_letter', relevance: 0.9 }];
    const deadLetter: IntrospectionOperation = {
      name: 'dead_letter',
      bucket: 'hour',
      relevance: () => 0.9,
      run: () => {
        throw new Error('act is stubbed in this test and never calls run');
      },
    };
    const act: Tier3ConsultDeps['act'] = (operation) => {
      runs.push(operation.name);
      return Promise.resolve({
        cycle: 1,
        health: healthFixture(),
        decision: { kind: 'selected', name: operation.name, tier: 3, urgency: 0.9, reason: 'r' },
        skipped: false,
        resolved: [],
      });
    };

    for (const senseEvidence of [
      [],
      ['bridge traversal: 40 bridge(s) observed', 'judgment durability: 0 unreversed'],
    ]) {
      const db = openSqliteHandle({ filePath: ':memory:' });
      await consultTier3(
        { ...deps(db, advisor), operations: [deadLetter], act },
        baseInput({ candidates, senseEvidence, lessons: [] }),
      );
      db.close();
    }

    // `acceptTier3Proposal` (`tier3.ts`) never takes evidence as a parameter at all: the gate
    // that decided to run `dead_letter` here could not have read either list.
    expect(runs).toEqual(['dead_letter', 'dead_letter']);
  });

  it('keeps the lesson out of introspection_insights: the two ledgers stay distinguishable', async () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    const advisor: Tier3Advisor = () =>
      Promise.resolve({
        status: 'declined',
        rationale: 'nothing to do',
        lesson: 'a model-authored guess, never a measurement',
      });

    await consultTier3(deps(db, advisor), baseInput());

    const insightRows = db.prepare('SELECT count(*) AS n FROM introspection_insights').get() as {
      n: number;
    };
    const lessonRows = db
      .prepare('SELECT count(*) AS n FROM introspection_model_lessons')
      .get() as { n: number };
    expect(insightRows.n).toBe(0);
    expect(lessonRows.n).toBe(1);
    db.close();
  });
});
