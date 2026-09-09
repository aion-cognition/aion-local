import { describe, expect, it } from 'vitest';

import { idAddress } from './address.js';
import {
  classifyCoverage,
  classifyEvidence,
  declinedPositionReason,
  evidenceResult,
  isDestructiveUse,
  isSelectableUse,
  isUsableForWrite,
  SELECTABLE_EVIDENCE_USES,
  type EvidenceIssue,
} from './result.js';

const ADDRESS = idAddress('episode-1');

function issue(
  reason: Exclude<EvidenceIssue['reason'], 'unsupported_history'>,
  required = true,
): EvidenceIssue {
  return { address: ADDRESS, field: 'source_content', reason, required };
}

describe('evidence result dimensions', () => {
  it('certifies the fields the request needed and nothing wider', () => {
    expect(classifyEvidence([])).toEqual({ status: 'complete-for-use' });
    expect(classifyEvidence([issue('unresolved_mapping', false)])).toEqual({
      status: 'complete-for-use',
    });
  });

  it('names an unreadable store as retryable ahead of every other required reason', () => {
    const issues = [issue('unresolved_mapping'), issue('store_unavailable')];

    expect(classifyEvidence(issues).status).toBe('unavailable-retryable');
    expect(classifyEvidence([issue('pending_publication')]).status).toBe('unavailable-retryable');
  });

  it('reports proved absence and proved suppression as answers rather than gaps', () => {
    expect(classifyEvidence([issue('not_found')]).status).toBe('not-found-in-coverage');
    expect(classifyEvidence([issue('suppressed_source')]).status).toBe('not-found-in-coverage');
    expect(classifyCoverage([issue('not_found')])).toEqual({ status: 'supported' });
    expect(classifyCoverage([issue('suppressed_source')])).toEqual({ status: 'supported' });
  });

  it('makes a required gap partial and leaves an optional one supported', () => {
    expect(classifyCoverage([issue('unverified_scope')]).status).toBe('unavailable');
    expect(classifyCoverage([issue('unverified_scope', false)]).status).toBe('supported');
  });

  it('carries requiredness for a missing required scope whatever the caller marked', () => {
    const marked = issue('required_scope_missing', false);

    expect(classifyEvidence([marked]).status).toBe('incomplete');
    expect(classifyCoverage([marked]).status).toBe('unavailable');
  });

  it('names every reason on an incomplete result, optional ones included', () => {
    const state = classifyEvidence([issue('unverified_scope'), issue('budget_limit', false)]);

    expect(state.status).toBe('incomplete');
    expect(state.status === 'incomplete' ? state.reasons : []).toHaveLength(2);
  });

  it('separates residency from completeness', () => {
    const evicted = evidenceResult({
      address: ADDRESS,
      residency: 'evicted',
      issues: [],
      value: 'raw text',
    });

    expect(evicted.residency).toBe('evicted');
    expect(evicted.evidence.status).toBe('complete-for-use');
    expect(isUsableForWrite(evicted)).toBe(true);
  });

  it('refuses a write on a value carried by an incomplete result', () => {
    const partial = evidenceResult({
      address: ADDRESS,
      residency: 'resident',
      issues: [issue('unverified_scope')],
      value: 'partially verified',
    });

    expect(partial.value).toBe('partially verified');
    expect(isUsableForWrite(partial)).toBe(false);
  });

  it('keeps the indexing purpose out of what a caller may name', () => {
    expect(isSelectableUse('raw_inspection')).toBe(true);
    expect(isSelectableUse('search_indexing')).toBe(false);
    expect(SELECTABLE_EVIDENCE_USES).not.toContain('search_indexing');
    expect(isDestructiveUse('claim_judgment')).toBe(true);
    expect(isDestructiveUse('serving_metadata')).toBe(false);
  });
});

/**
 * A decline is the publication layer's word and a gap is a caller's. Only the three that are
 * actually about a publication may be reported as one; anything else, named or not, is a store
 * that could not answer.
 */
describe('what a position the coordinator would not give says', () => {
  it('keeps the publication declines as publication declines', () => {
    expect(declinedPositionReason('pending_publication')).toBe('pending_publication');
    expect(declinedPositionReason('pending_recovery')).toBe('pending_publication');
    expect(declinedPositionReason('publication_changed')).toBe('pending_publication');
  });

  it('reports a store that could not answer as one, and never as a pending intent', () => {
    expect(declinedPositionReason('store_unavailable')).toBe('store_unavailable');
    expect(declinedPositionReason('store_busy')).toBe('store_unavailable');
    expect(declinedPositionReason('coordinator_not_initialized')).toBe('store_unavailable');
    expect(declinedPositionReason('enclosing_sqlite_transaction')).toBe('store_unavailable');
    // A word this reader has never seen proves nothing about a publication either.
    expect(declinedPositionReason('a reason from a later version')).toBe('store_unavailable');
  });
});
