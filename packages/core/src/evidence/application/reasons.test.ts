import type { HistoryCoverage } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import { addressForGapId, coverageIssueFor, evidenceGapId, statedCoverage } from './reasons.js';
import { idAddress, partAddress } from '../domain/address.js';
import type { EvidenceIssue } from '../domain/result.js';

const SUPPORTED: HistoryCoverage = {
  contract_version: 1,
  status: 'supported',
  limitations: [],
  gaps: [],
};

function issue(
  reason: Exclude<EvidenceIssue['reason'], 'unsupported_history'>,
  required = true,
): EvidenceIssue {
  return { address: idAddress('episode-1'), field: 'source_content', reason, required };
}

describe('resolver reasons on the wire', () => {
  it('addresses a part through the one validated conversion', () => {
    const part = partAddress('episode-1', 'turn', 3);

    expect(evidenceGapId(part)).toBe('part:episode-1:turn:3');
    expect(addressForGapId(evidenceGapId(part))).toEqual(part);
    expect(addressForGapId('episode-1')).toEqual(idAddress('episode-1'));
  });

  it('never collapses two parts of one source to the id they share', () => {
    const first = evidenceGapId(partAddress('episode-1', 'observation', 0));
    const second = evidenceGapId(partAddress('episode-1', 'observation', 1));

    expect(first).not.toBe(second);
    expect(first).not.toBe('episode-1');
  });

  it('carries the proved cause of a missing historical value', () => {
    const converted = coverageIssueFor({
      address: idAddress('episode-1'),
      field: 'source_clocks',
      reason: 'unsupported_history',
      historyReason: 'not_recorded',
      required: false,
    });

    expect(converted).toMatchObject({
      reason: 'unsupported_history',
      historyReason: 'not_recorded',
    });
  });

  it('makes a required gap partial and leaves an optional one listed', () => {
    const required = statedCoverage(SUPPORTED, [issue('unverified_scope')]);
    const optional = statedCoverage(SUPPORTED, [issue('unverified_scope', false)]);

    expect(required.coverage.status).toBe('partial');
    expect(required.coverage.gaps).toEqual([
      { id: 'episode-1', field: 'source_content', reason: 'unverified_scope' },
    ]);
    expect(optional.coverage.status).toBe('supported');
    expect(optional.coverage.gaps).toHaveLength(1);
  });

  it('reports proved suppression and certified absence as outcomes, not gaps', () => {
    const stated = statedCoverage(SUPPORTED, [issue('suppressed_source'), issue('not_found')]);

    expect(stated.coverage.status).toBe('supported');
    expect(stated.coverage.gaps).toEqual([]);
    expect(stated.outcomes.map((outcome) => outcome.outcome)).toEqual([
      'suppressed_source',
      'not_found',
    ]);
  });

  it('says one word for every way a traversal stopped short', () => {
    const stated = statedCoverage(SUPPORTED, [
      issue('cycle'),
      issue('depth_limit'),
      issue('budget_limit'),
    ]);

    expect(stated.coverage.gaps.map((gap) => gap.reason)).toEqual([
      'bounded_read',
      'bounded_read',
      'bounded_read',
    ]);
  });

  it('keeps an unknown mapping, a missing scope proof and a store outage apart', () => {
    const stated = statedCoverage(SUPPORTED, [
      issue('unresolved_mapping'),
      issue('unverified_scope'),
      issue('store_unavailable'),
    ]);

    expect(stated.coverage.gaps.map((gap) => gap.reason)).toEqual([
      'unresolved_mapping',
      'unverified_scope',
      'store_unavailable',
    ]);
  });
});
