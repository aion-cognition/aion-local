import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  advisorFor,
  clearIntrospectionState,
  engineFor,
  fakeOperation,
  NEXT_BUCKET,
  NEXT_QUARTER,
  noSecondOpinionProvider,
  NOW,
  seedTrackRecord,
  startEngineBed,
  stopEngineBed,
  strategicConfig,
  tier3Summary,
  type EngineBed,
  type FakeOperation,
} from './test-support/engine-bed.fixture.js';
import { operationStats } from '../../infrastructure/sqlite/introspection-counters.js';
import { appendIntrospectionInsight } from '../../infrastructure/sqlite/introspection-insights.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { operationBucketKey } from '../domain/buckets.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';
import type { Tier3Advisor, Tier3Outcome, Tier3Request } from '../domain/tier3.js';

let bed: EngineBed;

beforeAll(async () => {
  bed = await startEngineBed();
}, 300_000);

afterAll(async () => {
  await stopEngineBed(bed);
});

beforeEach(() => {
  clearIntrospectionState(bed.db);
  bed.db.exec('DELETE FROM introspection_insights');
});

/**
 * The strategic tier end to end. `dead_letter` is the operation under test throughout because
 * its relevance is a real backlog reading rather than a standing cadence; a stand-in keeps the
 * run itself cheap.
 */
describe('Introspector tier 3', () => {
  const PROPOSAL = {
    operation: 'dead_letter',
    confidence: 0.8,
    rationale: 'nine exhausted rows are waiting on their one retry',
  } as const;

  const ADVISED: Tier3Outcome = { status: 'advised', proposal: PROPOSAL };

  function subject(): FakeOperation {
    return fakeOperation('dead_letter', { relevance: () => 0.1 });
  }

  /**
   * The one cycle tier 3 is for: the deterministic tiers had nothing left to offer, because
   * the only operation with work to do is already covered by whoever holds its window. The
   * fall-through used to answer with the skipped report before the strategic layer was read,
   * so the layer was silent on exactly the cycles it exists for.
   */
  it('consults tier 3 on a cycle whose best candidate had already lost its window', async () => {
    const strategic = strategicConfig('propose');
    const requests: string[] = [];
    const advisor: Tier3Advisor = (request) => {
      requests.push(request.reason);
      return Promise.resolve({ status: 'declined', rationale: 'nothing needs doing' });
    };

    const dominant = fakeOperation('hourly_strategic', { bucket: 'hour', relevance: () => 1 });
    const small = fakeOperation('small_backlog', { relevance: () => 0.1 });
    const operations = [dominant, small];
    await engineFor(bed, operations, [healthFixture()], NOW, { config: strategic }).tickOnce();
    expect(dominant.calls()).toBe(1);

    // Same hour, next quarter-hour window: the claim is lost and what is left is under the
    // threshold, which is the cycle the strategic layer exists for.
    const report = await engineFor(bed, operations, [healthFixture()], NEXT_QUARTER, {
      config: strategic,
      tier3Advisor: advisor,
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(report.skipped).toBe(true);
    expect(requests).toHaveLength(1);
    expect(dominant.calls()).toBe(1);
    expect(small.calls()).toBe(0);
  });

  it('never consults the advisor while the knob is off', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      tier3Advisor: advisor,
    }).tickOnce();

    expect(report.decision.kind).toBe('idle');
    expect(advisor.calls()).toBe(0);
    expect(operation.calls()).toBe(0);
  });

  it('records the recommendation and runs nothing in propose mode', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();
    seedTrackRecord(bed.db, 'dead_letter');

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('propose'),
      tier3Advisor: advisor,
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(report.outcome).toBeUndefined();
    expect(operation.calls()).toBe(0);
    expect(tier3Summary(bed.db)).toMatchObject({
      mode: 'propose',
      outcome: 'advised',
      operation: 'dead_letter',
      confidence: 0.8,
      gate: 'accepted',
    });
  });

  /**
   * The restored authority, and the proof that nothing argues against the recommendation first:
   * the shared provider throws on any call, and the run still lands.
   */
  it('runs an accepted recommendation with no second opinion asked', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();
    seedTrackRecord(bed.db, 'dead_letter');

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: noSecondOpinionProvider,
    }).tickOnce();

    expect(report.decision).toMatchObject({ kind: 'selected', name: 'dead_letter', tier: 3 });
    expect(report.outcome).toMatchObject({ status: 'applied', itemsAffected: 2 });
    expect(operation.calls()).toBe(1);

    const bucket = getLedgerEntry(bed.db, operationBucketKey('dead_letter', 'quarter-hour', NOW));
    expect(bucket?.summary).toMatchObject({ operation: 'dead_letter', tier: 3, status: 'applied' });
    // The run parked its pre-run reading like any other, so the next cycle scores it.
    expect(operationStats(bed.db, 'dead_letter').pendingMeasure).toBe(0);
    expect(tier3Summary(bed.db)).toMatchObject({ mode: 'act', gate: 'accepted', ran: 'applied' });
  });

  it('runs an operation with no record at all, on the neutral cold-start prior', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: noSecondOpinionProvider,
    }).tickOnce();

    expect(report.decision).toMatchObject({ kind: 'selected', tier: 3 });
    expect(operation.calls()).toBe(1);
    expect(tier3Summary(bed.db)).toMatchObject({ gate: 'accepted', blended: 0.4 });
  });

  it('can select the bridge, which the deterministic tier could already schedule', async () => {
    const advisor = advisorFor({
      status: 'advised',
      proposal: { ...PROPOSAL, operation: 'symbiosis_bridge' },
    });
    const operation = fakeOperation('symbiosis_bridge', { relevance: () => 0.1 });

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: noSecondOpinionProvider,
    }).tickOnce();

    expect(report.decision).toMatchObject({ kind: 'selected', name: 'symbiosis_bridge', tier: 3 });
    expect(operation.calls()).toBe(1);
  });

  /** The blend is what downgrades a confident recommendation with a poor record. */
  it('keeps a recommendation for an operation whose runs stopped helping as a recommendation', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();
    seedTrackRecord(bed.db, 'dead_letter', 'unchanged');

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: noSecondOpinionProvider,
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(operation.calls()).toBe(0);
    expect(String(tier3Summary(bed.db).gate)).toContain('downgraded');
    expect(tier3Summary(bed.db).blended).toBe(0);
  });

  it('runs nothing in act mode when the recommendation names what cannot be taken back', async () => {
    const advisor = advisorFor({
      status: 'advised',
      proposal: { ...PROPOSAL, operation: 'episode_evict' },
    });
    const operation = fakeOperation('episode_evict', { relevance: () => 0.1 });
    seedTrackRecord(bed.db, 'episode_evict');

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: noSecondOpinionProvider,
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(operation.calls()).toBe(0);
    expect(String(tier3Summary(bed.db).gate)).toContain('cannot be taken back');
  });

  it('ends the cycle skipped when the accepted operation lost its bucket, without a second attempt', async () => {
    const second = subject();
    seedTrackRecord(bed.db, 'dead_letter');

    // One instance takes the window with a deterministic selection, and the strategic tier on
    // another instance lands on the same operation inside the same window.
    await engineFor(
      bed,
      [fakeOperation('dead_letter', { relevance: () => 1 })],
      [healthFixture()],
      NOW,
    ).tickOnce();

    const advisor = advisorFor(ADVISED);
    const report = await engineFor(bed, [second], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: noSecondOpinionProvider,
    }).tickOnce();

    expect(report.skipped).toBe(true);
    expect(second.calls()).toBe(0);
    expect(advisor.calls()).toBe(1);
    expect(tier3Summary(bed.db, 2).ran).toBe('the bucket was already claimed');
  });

  it('leaves the cycle idle and the loop alive when the advisor fails', async () => {
    const advisor = advisorFor({ status: 'failed', reason: 'the model never answered' });
    const operation = subject();
    seedTrackRecord(bed.db, 'dead_letter');

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(report.outcome).toBeUndefined();
    expect(operation.calls()).toBe(0);
    expect(tier3Summary(bed.db)).toMatchObject({ outcome: 'failed' });

    // The next cycle still consults and still acts: a failed consultation costs its own tick
    // and nothing else.
    const nextOperation = subject();
    const next = await engineFor(bed, [nextOperation], [healthFixture()], NEXT_BUCKET, {
      config: strategicConfig('act'),
      tier3Advisor: advisorFor(ADVISED),
      provider: noSecondOpinionProvider,
    }).tickOnce();
    expect(next.decision).toMatchObject({ kind: 'selected', tier: 3 });
    expect(nextOperation.calls()).toBe(1);
  });

  /**
   * The scoped refusal. A collector that failed is a reason not to act on the fields it feeds,
   * and the operations that read it report no work of their own. It is not a reason to stop the
   * loop thinking about the rest of the substrate.
   */
  it('still reaches the model on a degraded snapshot and acts on what the reading still covers', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();
    seedTrackRecord(bed.db, 'dead_letter');

    const report = await engineFor(
      bed,
      [operation],
      [healthFixture({ degraded: ['graph'] })],
      NOW,
      {
        config: strategicConfig('act'),
        tier3Advisor: advisor,
        provider: noSecondOpinionProvider,
      },
    ).tickOnce();

    expect(advisor.calls()).toBe(1);
    expect(report.decision).toMatchObject({ kind: 'selected', tier: 3 });
    expect(operation.calls()).toBe(1);
  });

  it('refuses the operation whose own evidence was the collector that failed', async () => {
    const advisor = advisorFor({
      status: 'advised',
      proposal: { ...PROPOSAL, operation: 'graph_reader' },
    });
    // What an operation that reads the failed collector returns for its own demand.
    const operation = fakeOperation('graph_reader', {
      relevance: (health) => (health.degraded.includes('graph') ? 0 : 1),
    });
    const other = fakeOperation('dead_letter', { relevance: () => 0.1 });

    const report = await engineFor(
      bed,
      [operation, other],
      [healthFixture({ degraded: ['graph'] })],
      NOW,
      {
        config: strategicConfig('act'),
        tier3Advisor: advisor,
        provider: noSecondOpinionProvider,
      },
    ).tickOnce();

    expect(advisor.calls()).toBe(1);
    expect(report.decision.kind).toBe('tier3');
    expect(operation.calls()).toBe(0);
    expect(String(tier3Summary(bed.db).gate)).toContain('reports no work to do');
  });

  /** The loop's own history reaches the prompt, not only the table of ratios. */
  it('hands the advisor the lessons its recent runs left', async () => {
    const seen: Tier3Request[] = [];
    const advisor: Tier3Advisor = (request) => {
      seen.push(request);
      return Promise.resolve({ status: 'declined', rationale: 'nothing needs doing' });
    };
    appendIntrospectionInsight(bed.db, {
      operation: 'dead_letter',
      lesson: 'ran with its metric at 9 and did not move it: the next reading was 9',
    });

    await engineFor(bed, [subject()], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
    }).tickOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.insights?.join('\n')).toContain('did not move it');
  });

  it('writes a lesson from each run it scores, so the next consultation reads one', async () => {
    const operation = fakeOperation('dead_letter', { relevance: () => 1 });

    // One tick runs it and parks the pre-run reading; the next tick resolves that reading.
    await engineFor(bed, [operation], [healthFixture()], NOW).tickOnce();
    await engineFor(bed, [operation], [healthFixture()], NEXT_BUCKET).tickOnce();

    const lessons = bed.db
      .prepare('SELECT operation, lesson FROM introspection_insights ORDER BY id')
      .all() as { operation: string; lesson: string }[];
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.operation).toBe('dead_letter');
    expect(lessons[0]?.lesson).toContain('its metric at');
  });
});
