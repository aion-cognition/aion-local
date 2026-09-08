import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_LIMITS,
  JUDGE_ROUTES,
  JUDGE_ROUTE_ALLOWANCE,
  RequestBudget,
  renderableUnits,
  utf16CodeUnits,
  utf8Bytes,
} from './budget.js';
import { MAX_LINEAGE_HOPS } from '../../infrastructure/graph/claim-lineage-queries.js';

describe('the request budget', () => {
  it('spends one allowance across every subread rather than one per step', () => {
    const budget = new RequestBudget({ ...EVIDENCE_LIMITS, requestedIds: 3 });

    expect(budget.chargeIds(2)).toBeUndefined();
    expect(budget.chargeIds(1)).toBeUndefined();
    expect(budget.chargeIds(1)).toBe('requested_ids');
    expect(budget.spent().requested_ids).toBe(3);
  });

  it('answers at the bound and refuses one past it', () => {
    const budget = new RequestBudget({ ...EVIDENCE_LIMITS, decodedRawBytes: 100 });

    expect(budget.chargeRawBytes(100)).toBeUndefined();
    expect(budget.chargeRawBytes(1)).toBe('decoded_raw_bytes');
    expect(budget.spent().decoded_raw_bytes).toBe(100);
  });

  it('spends nothing on a charge that does not fit', () => {
    const budget = new RequestBudget({ ...EVIDENCE_LIMITS, relationRows: 10 });

    budget.chargeRelationRows(9);
    expect(budget.chargeRelationRows(2)).toBe('relation_rows');
    expect(budget.chargeRelationRows(1)).toBeUndefined();
  });

  it('allows one checkpoint read to certify and one to recheck', () => {
    const budget = new RequestBudget();

    expect(budget.takeCheckpointAttempt()).toBeUndefined();
    expect(budget.takeCheckpointAttempt()).toBeUndefined();
    expect(budget.takeCheckpointAttempt()).toBe('checkpoint_attempts');
  });

  it('keeps the ancestry bound where the walk defines it', () => {
    expect(EVIDENCE_LIMITS.lineageHops).toBe(MAX_LINEAGE_HOPS);
  });

  it('measures the two size units from the text rather than by a multiplier', () => {
    const text = 'né\u{1F600}';

    expect(utf8Bytes(text)).toBe(7);
    expect(utf16CodeUnits(text)).toBe(4);
  });

  it('leaves a route the units its fixed reserve does not take', () => {
    expect(renderableUnits({ route: 'claim_dedup', reservedUnits: 384 })).toBe(
      JUDGE_ROUTE_ALLOWANCE.claim_dedup - 384,
    );
  });

  it('leaves no room at all to a route reserving more than its allowance', () => {
    expect(renderableUnits({ route: 'entity_merge', reservedUnits: 999999 })).toBe(0);
  });

  it('gives every judgment route an allowance', () => {
    for (const route of JUDGE_ROUTES) {
      expect(JUDGE_ROUTE_ALLOWANCE[route]).toBeGreaterThan(0);
    }
  });
});
