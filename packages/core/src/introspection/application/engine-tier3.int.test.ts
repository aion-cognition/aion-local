import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { operationStats } from '../../infrastructure/sqlite/introspection-counters.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { operationBucketKey } from '../domain/buckets.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';
import type { Tier3Advisor, Tier3Outcome } from '../domain/tier3.js';
import {
  advisorFor,
  clearIntrospectionState,
  engineFor,
  fakeOperation,
  NEXT_BUCKET,
  NEXT_QUARTER,
  NOW,
  reviewingProvider,
  seedTrackRecord,
  startEngineBed,
  stopEngineBed,
  strategicConfig,
  tier3Summary,
  type EngineBed,
  type FakeOperation,
} from './test-support/engine-bed.fixture.js';

let bed: EngineBed;

beforeAll(async () => {
  bed = await startEngineBed();
}, 300_000);

afterAll(async () => {
  await stopEngineBed(bed);
});

beforeEach(() => {
  clearIntrospectionState(bed.db);
});

/**
 * The strategic tier end to end. `dead_letter` is the operation under test throughout because
 * it is on the act allowlist and its relevance is a real backlog reading rather than a standing
 * cadence; a stand-in keeps the run itself cheap.
 */
describe('Introspector tier 3', () => {
  const PROPOSAL = {
    operation: 'dead_letter',
    confidence: 0.7,
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
      confidence: 0.7,
      gate: 'accepted',
    });
  });

  it('runs an upheld recommendation through the same claim and scoring path as any selection', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();
    seedTrackRecord(bed.db, 'dead_letter');

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: reviewingProvider(true),
    }).tickOnce();

    expect(report.decision).toMatchObject({ kind: 'selected', name: 'dead_letter', tier: 3 });
    expect(report.outcome).toMatchObject({ status: 'applied', itemsAffected: 2 });
    expect(operation.calls()).toBe(1);

    const bucket = getLedgerEntry(bed.db, operationBucketKey('dead_letter', 'quarter-hour', NOW));
    expect(bucket?.summary).toMatchObject({ operation: 'dead_letter', tier: 3, status: 'applied' });
    // The run parked its pre-run reading like any other, so the next cycle scores it.
    expect(operationStats(bed.db, 'dead_letter').pendingMeasure).toBe(0);
    expect(tier3Summary(bed.db)).toMatchObject({ mode: 'act', review: 'upheld', ran: 'applied' });
  });

  it('keeps a vetoed recommendation as a recommendation', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();
    seedTrackRecord(bed.db, 'dead_letter');

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: reviewingProvider(false),
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(operation.calls()).toBe(0);
    expect(tier3Summary(bed.db).review).toContain('vetoed');
  });

  it('runs nothing in act mode when the recommendation names an operation outside the allowlist', async () => {
    const advisor = advisorFor({
      status: 'advised',
      proposal: { ...PROPOSAL, operation: 'symbiosis_bridge' },
    });
    const operation = fakeOperation('symbiosis_bridge', { relevance: () => 0.1 });
    seedTrackRecord(bed.db, 'symbiosis_bridge');

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: reviewingProvider(true),
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(operation.calls()).toBe(0);
    expect(tier3Summary(bed.db).gate).toContain('downgraded');
  });

  it('runs nothing in act mode until the operation has resolved a run of its own', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();

    const report = await engineFor(bed, [operation], [healthFixture()], NOW, {
      config: strategicConfig('act'),
      tier3Advisor: advisor,
      provider: reviewingProvider(true),
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(operation.calls()).toBe(0);
    expect(tier3Summary(bed.db).gate).toContain('never been seen to succeed');
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
      provider: reviewingProvider(true),
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

    // The next cycle still runs: a failed consultation costs its own tick and nothing else.
    const next = await engineFor(bed, [subject()], [healthFixture()], NEXT_BUCKET, {
      config: strategicConfig('act'),
      tier3Advisor: advisorFor(ADVISED),
    }).tickOnce();
    expect(next.decision.kind).toBe('tier3');
  });

  it('never reaches the model on a degraded snapshot', async () => {
    const advisor = advisorFor(ADVISED);
    const operation = subject();
    seedTrackRecord(bed.db, 'dead_letter');

    const report = await engineFor(
      bed,
      [operation],
      [healthFixture({ degraded: ['queue'] })],
      NOW,
      {
        config: strategicConfig('act'),
        tier3Advisor: advisor,
        provider: reviewingProvider(true),
      },
    ).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(advisor.calls()).toBe(0);
    expect(operation.calls()).toBe(0);
    expect(tier3Summary(bed.db)).toMatchObject({ outcome: 'skipped' });
    expect(String(tier3Summary(bed.db).detail)).toContain('degraded');
  });
});
