import { describe, expect, it } from 'vitest';

import {
  BATCH_SETTLEMENT_STANDING_RELEVANCE,
  batchSettlementRelevance,
  NEUTRAL_BATCH_DEMAND,
  type BatchDemand,
} from './batch-settlement.js';

const HOUR_MS = 60 * 60 * 1000;
const SCALES = { fullWaitMs: 2 * HOUR_MS };

function lane(overrides: Partial<BatchDemand> = {}): BatchDemand {
  return {
    ...NEUTRAL_BATCH_DEMAND,
    availability: 'measured',
    diagnostic: undefined,
    ...overrides,
  };
}

describe('batch settlement relevance', () => {
  it('yields the tick when nothing waits', () => {
    expect(batchSettlementRelevance(lane(), SCALES)).toBe(0);
  });

  it('keeps the standing claim when the lane could not be read', () => {
    expect(batchSettlementRelevance(NEUTRAL_BATCH_DEMAND, SCALES)).toBe(
      BATCH_SETTLEMENT_STANDING_RELEVANCE,
    );
  });

  it('rises with how long never-sent work has waited, up to full relevance', () => {
    const fresh = batchSettlementRelevance(lane({ sendable: 10, localWaitMs: 0 }), SCALES);
    const hour = batchSettlementRelevance(lane({ sendable: 10, localWaitMs: HOUR_MS }), SCALES);
    const day = batchSettlementRelevance(lane({ sendable: 10, localWaitMs: 24 * HOUR_MS }), SCALES);

    expect(fresh).toBe(BATCH_SETTLEMENT_STANDING_RELEVANCE);
    expect(hour).toBeCloseTo(0.5);
    expect(day).toBe(1);
  });

  it('counts never-sent work for the unselected provider, which a run discards', () => {
    expect(batchSettlementRelevance(lane({ obsolete: 5, localWaitMs: 3 * HOUR_MS }), SCALES)).toBe(
      1,
    );
  });

  it('scores remote work by its wait since it was sent or last checked', () => {
    expect(
      batchSettlementRelevance(lane({ outstanding: 10, remoteWaitMs: HOUR_MS / 2 }), SCALES),
    ).toBeCloseTo(0.25);
  });

  it('scores nothing for work no run can move', () => {
    const stuck = lane({
      blocked: 10,
      blockedBy: 'missing_key',
      unreadable: 4,
      localWaitMs: undefined,
      remoteWaitMs: undefined,
    });
    expect(batchSettlementRelevance(stuck, SCALES)).toBe(0);
    expect(batchSettlementRelevance({ ...stuck, blockedBy: 'spent_ceiling' }, SCALES)).toBe(0);
  });
});
