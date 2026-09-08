import {
  CoverageGapReasonSchema,
  CoverageLimitationSchema,
  CoverageRefusalReasonSchema,
  type CoverageRefusal,
  type HistoryCoverage,
} from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import { coverageLines, refusalLines } from './coverage-text.js';

const H = '2026-09-08T02:00:00.000Z';
const NOW = '2026-09-08T06:00:00.000Z';

describe('the coverage statement in prose', () => {
  it('says the status, the boundary and the vantage that was asked', () => {
    const lines = coverageLines({
      contract_version: 1,
      history_since: H,
      status: 'supported',
      as_of: '2019-01-01T00:00:00.000Z',
      knew_at: '2026-09-08T04:00:00.000Z',
      limitations: [],
      gaps: [],
    });

    expect(lines).toEqual([
      `history: supported, covered since ${H}, asked as_of 2019-01-01T00:00:00.000Z and knew_at 2026-09-08T04:00:00.000Z.`,
    ]);
  });

  it('says there is no boundary rather than printing one, while the record is preparing', () => {
    const lines = coverageLines({
      contract_version: 1,
      status: 'partial',
      knew_at: '2026-09-08T04:00:00.000Z',
      limitations: ['coverage_contract_not_active'],
      gaps: [],
    });

    expect(lines[0]).toContain('no coverage boundary yet');
    expect(lines[0]).toContain('partial');
    expect(lines[1]).toContain('coverage_contract_not_active');
    expect(lines.join(' ')).not.toContain(H);
  });

  it('names every limitation and gap the json carries, with its own id', () => {
    const coverage: HistoryCoverage = {
      contract_version: 1,
      history_since: H,
      status: 'partial',
      limitations: ['gap_list_truncated'],
      gaps: [
        { id: 'part:source-1:turn:0', field: 'source_clocks', reason: 'not_recorded' },
        { field: 'link_interval', reason: 'required_scope_missing' },
      ],
    };

    const text = coverageLines(coverage).join('\n');

    for (const limitation of coverage.limitations) {
      expect(text).toContain(limitation);
    }
    for (const gap of coverage.gaps) {
      expect(text).toContain(gap.field);
      expect(text).toContain(gap.reason);
      if (gap.id !== undefined) {
        expect(text).toContain(gap.id);
      }
    }
    expect(coverageLines(coverage)).toHaveLength(4);
  });

  it('has words for every reason and limitation the vocabulary holds', () => {
    for (const reason of CoverageGapReasonSchema.options) {
      const [, line] = coverageLines({
        contract_version: 1,
        status: 'partial',
        limitations: [],
        gaps: [{ field: 'ownership', reason }],
      });
      expect(line).toMatch(/^gap: ownership .+\.$/);
      expect(line).toContain(reason);
      expect(line).not.toContain('undefined');
    }
    for (const limitation of CoverageLimitationSchema.options) {
      const [, line] = coverageLines({
        contract_version: 1,
        status: 'partial',
        limitations: [limitation],
        gaps: [],
      });
      expect(line).toMatch(/^limitation: .+\.$/);
      expect(line).toContain(limitation);
      expect(line).not.toContain('undefined');
    }
  });
});

describe('a refusal in prose', () => {
  function refusal(over: Partial<CoverageRefusal> = {}): CoverageRefusal {
    return {
      contract_version: 1,
      reason: 'before_horizon',
      requested: { knew_at: '2020-01-01T00:00:00.000Z', now: NOW },
      bounds: { history_since: H, coverage_state: 'active' },
      ...over,
    };
  }

  it('names the request and the boundary it fell outside', () => {
    expect(refusalLines(refusal())).toEqual([
      `refused: knew_at 2020-01-01T00:00:00.000Z is before the coverage boundary ${H} (before_horizon).`,
    ]);
  });

  it('separates knowledge nobody has yet from a boundary refusal', () => {
    const line = refusalLines(refusal({ reason: 'future_knowledge' }))[0] ?? '';

    expect(line).toContain('future_knowledge');
    expect(line).toContain(NOW);
    expect(line).not.toContain('before the coverage boundary');
  });

  it('has words for every refusal reason, with none of them left blank', () => {
    for (const reason of CoverageRefusalReasonSchema.options) {
      const [line] = refusalLines(refusal({ reason, bounds: {} }));
      expect(line).toContain(reason);
      expect(line).not.toContain('undefined');
      expect(line).toMatch(/^refused: .+\.$/);
    }
  });
});
