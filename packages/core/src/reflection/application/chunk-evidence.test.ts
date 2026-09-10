import { describe, expect, it } from 'vitest';

import { ChunkDependencySet, readingOf } from './chunk-evidence.js';
import type { SourceEvidence } from '../../evidence/application/sources.js';
import { idAddress } from '../../evidence/domain/address.js';
import { evidenceResult, type EvidenceIssue } from '../../evidence/domain/result.js';

/**
 * The two readings the chunk decisions are built on: what one answer about a source says, and
 * what a request's whole dependency set is once more than one read contributed to it.
 */

function issue(reason: EvidenceIssue['reason']): EvidenceIssue {
  if (reason === 'unsupported_history') {
    return {
      address: idAddress('s1'),
      field: 'eligibility',
      reason,
      historyReason: 'not_recorded',
      required: true,
    };
  }
  return { address: idAddress('s1'), field: 'source_content', reason, required: true };
}

function reading(issues: readonly EvidenceIssue[], value?: SourceEvidence) {
  return evidenceResult<SourceEvidence>({
    address: idAddress('s1'),
    residency: 'resident',
    issues,
    ...(value === undefined ? {} : { value }),
  });
}

const evidence = {
  sourceId: 's1',
  sessionId: 'session',
  occurredAt: '2026-09-09T06:00:00.000Z',
  text: 'body',
  sourceText: 'body',
  parts: [],
  decodedRawUtf8Bytes: 4,
  rawUtf16CodeUnits: 4,
} satisfies SourceEvidence;

describe('what one answer about a source says', () => {
  it('separates a proved suppression, a bound, a store failure and an unproved reading', () => {
    expect(readingOf(reading([], evidence))).toBe('complete');
    expect(readingOf(reading([issue('suppressed_source')]))).toBe('suppressed');
    expect(readingOf(reading([issue('budget_limit')]))).toBe('over_budget');
    expect(readingOf(reading([issue('unresolved_mapping')]))).toBe('unreadable');
    expect(readingOf(reading([issue('store_unavailable')]))).toBe('unreadable');
    expect(readingOf(reading([issue('unsupported_history')]))).toBe('unproved');
    expect(readingOf(undefined)).toBe('unreadable');
  });
});

describe('one request folded from several reads', () => {
  const first = { kind: 'source' as const, id: 's1', scope: 'source.content', version: 'v1' };
  const second = { kind: 'source' as const, id: 's2', scope: 'source.state', version: 'v1' };

  /**
   * The R4 case in miniature: an address the batch never reached acquires its tokens in the
   * reread, and a set that kept only the batch's would be fenced on nothing for that member.
   */
  it('carries every read`s dependencies, not just the first read`s', () => {
    const set = new ChunkDependencySet();
    set.addAll([first]);
    set.addAll([second]);
    expect(set.list()).toEqual([first, second]);
    expect(set.conflicted('s1')).toBe(false);
    expect(set.conflicted('s2')).toBe(false);
  });

  it('folds a repeated identical observation once', () => {
    const set = new ChunkDependencySet();
    set.addAll([first, { ...first }]);
    expect(set.list()).toEqual([first]);
  });

  /**
   * Two readings of one scope that disagree are two moments. Choosing between them would fence a
   * revision on a coherence the request never had, so the endpoint is recorded as conflicted and
   * its caller fails that reading instead.
   */
  it('records a disagreement rather than letting one token overwrite the other', () => {
    const set = new ChunkDependencySet();
    set.addAll([first]);
    set.addAll([{ ...first, version: 'v2' }, second]);
    expect(set.conflicted('s1')).toBe(true);
    expect(set.conflicted('s2')).toBe(false);
    expect(set.list()).toContainEqual(first);
    expect(set.list()).not.toContainEqual({ ...first, version: 'v2' });
  });

  it('keeps one endpoint`s scopes apart, so a different scope is not a conflict', () => {
    const set = new ChunkDependencySet();
    set.addAll([first]);
    set.addAll([{ ...first, scope: 'source.parts', version: 'v9' }]);
    expect(set.conflicted('s1')).toBe(false);
    expect(set.list()).toHaveLength(2);
  });
});
