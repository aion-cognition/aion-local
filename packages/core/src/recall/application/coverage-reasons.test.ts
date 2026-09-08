import { HISTORY_GAP_REASONS, type HistoryCoverage } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import {
  applyEvidence,
  coverageGapId,
  COVERAGE_GAP_LIMIT,
  decodeCoverageGapId,
  evidenceTreatment,
  EVIDENCE_ISSUE_REASONS,
  type EvidenceIssue,
} from './coverage-reasons.js';

const SUPPORTED: HistoryCoverage = {
  contract_version: 1,
  history_since: '2026-09-08T02:00:00.000Z',
  status: 'supported',
  knew_at: '2026-09-08T04:00:00.000Z',
  limitations: [],
  gaps: [],
};

function issue(over: Partial<EvidenceIssue> = {}): EvidenceIssue {
  return { reason: 'store_unavailable', field: 'source_content', required: true, ...over };
}

describe('one issue to one transport treatment', () => {
  it('keeps an unknown mapping distinct from a verified missing source', () => {
    expect(evidenceTreatment(issue({ reason: 'unresolved_mapping', id: 'source-1' }))).toEqual({
      kind: 'gap',
      gap: { id: 'source-1', field: 'source_content', reason: 'unresolved_mapping' },
    });
  });

  it('keeps a missing scope proof distinct from a store outage', () => {
    expect(evidenceTreatment(issue({ reason: 'unverified_scope' })).kind).toBe('gap');
    expect(evidenceTreatment(issue({ reason: 'unverified_scope' }))).not.toEqual(
      evidenceTreatment(issue({ reason: 'store_unavailable' })),
    );
  });

  it('carries the proved cause of a missing historical value, never a guessed one', () => {
    for (const historyReason of HISTORY_GAP_REASONS) {
      expect(
        evidenceTreatment(issue({ reason: 'unsupported_history', historyReason })),
      ).toMatchObject({ kind: 'gap', gap: { reason: historyReason } });
    }
    expect(() => evidenceTreatment(issue({ reason: 'unsupported_history' }))).toThrow(
      /proved cause/,
    );
  });

  it('says one thing about every traversal that stopped on a bound', () => {
    for (const reason of ['cycle', 'depth_limit', 'budget_limit'] as const) {
      expect(evidenceTreatment(issue({ reason }))).toMatchObject({
        kind: 'gap',
        gap: { reason: 'bounded_read' },
      });
    }
  });

  it('reports proved suppression as an outcome, not a gap', () => {
    expect(evidenceTreatment(issue({ reason: 'suppressed_source', field: 'eligibility' }))).toEqual(
      {
        kind: 'result',
        outcome: 'suppressed_source',
      },
    );
  });

  it('reports certified absence as an outcome, not a gap', () => {
    expect(evidenceTreatment(issue({ reason: 'not_found' }))).toEqual({
      kind: 'result',
      outcome: 'not_found',
    });
  });

  it('carries a missing required scope as a gap, for transports that see no evidence state', () => {
    expect(
      evidenceTreatment(issue({ reason: 'required_scope_missing', field: 'link_interval' })),
    ).toEqual({
      kind: 'gap',
      gap: { field: 'link_interval', reason: 'required_scope_missing' },
    });
  });

  it('treats every reason the resolver can produce', () => {
    for (const reason of EVIDENCE_ISSUE_REASONS) {
      const treated = evidenceTreatment(
        issue(
          reason === 'unsupported_history' ? { reason, historyReason: 'not_recorded' } : { reason },
        ),
      );
      expect(['gap', 'result']).toContain(treated.kind);
    }
  });
});

describe('folding a run of issues into the statement', () => {
  it('makes a result partial on a required-field gap', () => {
    const { coverage } = applyEvidence(SUPPORTED, [issue({ reason: 'pending_publication' })]);

    expect(coverage.status).toBe('partial');
    expect(coverage.gaps).toEqual([{ field: 'source_content', reason: 'pending_publication' }]);
  });

  it('leaves a supported result supported on suppression and certified absence alone', () => {
    const { coverage, outcomes } = applyEvidence(SUPPORTED, [
      issue({ reason: 'suppressed_source', field: 'eligibility', id: 'source-9' }),
      issue({ reason: 'not_found', field: 'source_content' }),
    ]);

    expect(coverage.status).toBe('supported');
    expect(coverage.gaps).toEqual([]);
    expect(outcomes).toEqual([
      { outcome: 'suppressed_source', field: 'eligibility', id: 'source-9' },
      { outcome: 'not_found', field: 'source_content' },
    ]);
  });

  it('leaves an optional-field gap listed without calling the answer partial', () => {
    const { coverage } = applyEvidence(SUPPORTED, [
      issue({ reason: 'unresolved_reference', field: 'reference_history', required: false }),
    ]);

    expect(coverage.status).toBe('supported');
    expect(coverage.gaps).toHaveLength(1);
  });

  it('cuts the gap list at its limit and discloses the cut', () => {
    const issues = Array.from({ length: COVERAGE_GAP_LIMIT + 1 }, (_, index) =>
      issue({ reason: 'unresolved_mapping', id: `source-${String(index)}` }),
    );

    const { coverage } = applyEvidence(SUPPORTED, issues);

    expect(coverage.gaps).toHaveLength(COVERAGE_GAP_LIMIT);
    expect(coverage.gaps.at(-1)?.id).toBe(`source-${String(COVERAGE_GAP_LIMIT - 1)}`);
    expect(coverage.limitations).toEqual(['gap_list_truncated']);
    expect(coverage.status).toBe('partial');
  });

  it('never turns a partial statement back into a supported one', () => {
    const preparing: HistoryCoverage = {
      contract_version: 1,
      status: 'partial',
      limitations: ['coverage_contract_not_active'],
      gaps: [],
    };

    const { coverage } = applyEvidence(preparing, [issue({ reason: 'not_found' })]);

    expect(coverage.status).toBe('partial');
    expect(coverage.limitations).toEqual(['coverage_contract_not_active']);
  });

  it('keeps the boundary and the asked vantage the checker put on the statement', () => {
    const { coverage } = applyEvidence(SUPPORTED, [issue()]);

    expect(coverage.history_since).toBe(SUPPORTED.history_since);
    expect(coverage.knew_at).toBe(SUPPORTED.knew_at);
    expect(coverage.contract_version).toBe(1);
  });
});

describe('what a gap points at', () => {
  it('keeps two parts of one source apart', () => {
    const first = coverageGapId({
      kind: 'part',
      sourceId: 'source-1',
      partKind: 'observation',
      ordinal: 0,
    });
    const second = coverageGapId({
      kind: 'part',
      sourceId: 'source-1',
      partKind: 'observation',
      ordinal: 1,
    });

    expect(first).toBe('part:source-1:observation:0');
    expect(first).not.toBe(second);
  });

  it('round-trips a part address and a node id through one conversion', () => {
    const part = {
      kind: 'part',
      sourceId: 'source-1',
      partKind: 'turn',
      ordinal: 3,
    } as const;

    expect(decodeCoverageGapId(coverageGapId(part))).toEqual(part);
    expect(decodeCoverageGapId(coverageGapId({ kind: 'node', id: 'episode-7' }))).toEqual({
      kind: 'node',
      id: 'episode-7',
    });
  });

  it('reads an address that does not encode back to itself as a plain id', () => {
    expect(decodeCoverageGapId('part:source-1:turn:03')).toEqual({
      kind: 'node',
      id: 'part:source-1:turn:03',
    });
    expect(decodeCoverageGapId('part:source-1:turn:last')).toEqual({
      kind: 'node',
      id: 'part:source-1:turn:last',
    });
  });
});
