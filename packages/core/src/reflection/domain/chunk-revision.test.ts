import { describe, expect, it } from 'vitest';

import type { ChunkMemberText } from './chunk-render.js';
import {
  decideChunkRevision,
  planChunkInput,
  transitionEndpoints,
  type ChunkEvidenceReading,
  type ChunkMemberEvidence,
} from './chunk-revision.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';

const OCCURRED = new Date('2026-09-09T10:00:00.000Z');
const ALLOWANCE = 100_000;

function text(sourceId: string, body = 'body'): ChunkMemberText {
  return { sourceId, occurredAt: OCCURRED, text: body, parts: [{ address: sourceId, text: body }] };
}

function member(sourceId: string, reading: ChunkEvidenceReading = 'complete'): ChunkMemberEvidence {
  return reading === 'complete'
    ? { sourceId, reading, text: text(sourceId) }
    : { sourceId, reading };
}

function blockReason(plan: ReturnType<typeof planChunkInput>): string {
  return plan.status === 'block' ? plan.reason : 'render';
}

describe('what a revision may submit', () => {
  it('renders every member of a healthy chunk with no gaps', () => {
    const plan = planChunkInput({
      members: [member('s1'), member('s2')],
      allowance: ALLOWANCE,
    });
    expect(plan.status).toBe('render');
    if (plan.status === 'render') {
      expect(plan.members.map((entry) => entry.sourceId)).toEqual(['s1', 's2']);
      expect(plan.gaps).toEqual([]);
      expect(plan.transition).toEqual([]);
    }
  });

  /**
   * The forget ruling's amendment. One forgotten member does not poison the chunk: its content
   * reaches no model input, the gap says so against its own source, and the healthy members are
   * submitted whole so their coverage stands on its own.
   */
  it('omits a proved suppressed member and records the gap against its source', () => {
    const plan = planChunkInput({
      members: [member('s1'), member('s2', 'suppressed'), member('s3')],
      allowance: ALLOWANCE,
    });
    expect(plan.status).toBe('render');
    if (plan.status === 'render') {
      expect(plan.members.map((entry) => entry.sourceId)).toEqual(['s1', 's3']);
      expect(plan.gaps).toEqual([{ reason: 'suppressed_member', sourceId: 's2' }]);
    }
  });

  it('blocks a chunk with nothing admissible left in it', () => {
    const plan = planChunkInput({
      members: [member('s1', 'suppressed'), member('s2', 'suppressed')],
      allowance: ALLOWANCE,
    });
    expect(blockReason(plan)).toBe('no_admissible_input');
  });

  it('blocks on a member whose evidence nobody could read', () => {
    expect(
      blockReason(
        planChunkInput({
          members: [member('s1'), member('s2', 'unreadable')],
          allowance: ALLOWANCE,
        }),
      ),
    ).toBe('member_evidence_missing');
  });

  /** Unknown is not a proved gap, so it cannot buy neighbours their coverage. */
  it('blocks the whole revision on an unscoped gap rather than gapping the member', () => {
    expect(
      blockReason(
        planChunkInput({
          members: [member('s1'), member('s2', 'unproved')],
          allowance: ALLOWANCE,
        }),
      ),
    ).toBe('unscoped_coverage_gap');
  });

  it('blocks a member over the resolver budget rather than submitting part of it', () => {
    expect(
      blockReason(planChunkInput({ members: [member('s1', 'over_budget')], allowance: ALLOWANCE })),
    ).toBe('member_over_resolver_budget');
  });

  it('gaps a member the resolver served whole and the allowance cannot carry whole', () => {
    const plan = planChunkInput({
      members: [member('s1')],
      allowance: ALLOWANCE,
      oversizedMember: 's1',
      submittedRanges: [{ address: 'part:s1:turn:0', start: 0, end: 40 }],
    });
    expect(plan.status).toBe('render');
    if (plan.status === 'render') {
      expect(plan.boundedPartialOf).toBe('s1');
      expect(plan.gaps).toEqual([
        {
          reason: 'oversized_member',
          sourceId: 's1',
          submitted: [{ address: 'part:s1:turn:0', start: 0, end: 40 }],
        },
      ]);
    }
  });
});

describe('regrounding transition evidence', () => {
  it('submits the changed external evidence beside the frozen membership', () => {
    const plan = planChunkInput({
      members: [member('s1')],
      transition: [member('external-1')],
      allowance: ALLOWANCE,
    });
    expect(plan.status).toBe('render');
    if (plan.status === 'render') {
      expect(plan.members.map((entry) => entry.sourceId)).toEqual(['s1']);
      expect(plan.transition.map((entry) => entry.sourceId)).toEqual(['external-1']);
    }
  });

  /**
   * The AD-1 refusal, and the one the forget ruling keeps as a whole-revision block: omitting a
   * suppressed correction and publishing anyway would certify an uncorrected reading as current.
   */
  it('blocks the whole revision when the required correction is proved suppressed', () => {
    expect(
      blockReason(
        planChunkInput({
          members: [member('s1')],
          transition: [member('external-1', 'suppressed')],
          allowance: ALLOWANCE,
        }),
      ),
    ).toBe('required_transition_evidence_suppressed');
  });

  it('blocks the whole revision when the required correction cannot be read', () => {
    expect(
      blockReason(
        planChunkInput({
          members: [member('s1')],
          transition: [member('external-1', 'unreadable')],
          allowance: ALLOWANCE,
        }),
      ),
    ).toBe('required_transition_evidence_unavailable');
  });

  it('blocks rather than dropping the correction when it does not fit beside the members', () => {
    const plan = planChunkInput({
      members: [{ sourceId: 's1', reading: 'complete', text: text('s1', 'a'.repeat(400)) }],
      transition: [
        { sourceId: 'external-1', reading: 'complete', text: text('external-1', 'b'.repeat(400)) },
      ],
      allowance: 500,
    });
    expect(blockReason(plan)).toBe('required_transition_evidence_unavailable');
  });

  it('takes a suppressed member and a suppressed correction as two different answers', () => {
    const both = planChunkInput({
      members: [member('s1'), member('s2', 'suppressed')],
      transition: [member('external-1', 'suppressed')],
      allowance: ALLOWANCE,
    });
    expect(blockReason(both)).toBe('required_transition_evidence_suppressed');
  });
});

describe('whether a chunk owes a revision', () => {
  const head = { revisionNo: 1, nodeId: 'node-1' };

  it('synthesizes a chunk that has never published', () => {
    expect(decideChunkRevision(undefined, undefined)).toEqual({
      action: 'synthesize',
      reason: 'no_published_head',
      changed: [],
    });
  });

  it('leaves a head whose dependency versions still read the same', () => {
    expect(decideChunkRevision(head, { status: 'current' })).toEqual({
      action: 'skip',
      reason: 'head_current',
    });
  });

  it('regrounds a head whose dependencies moved, carrying what changed', () => {
    const changed = [
      { kind: 'source' as const, id: 'external-1', scope: 'source.content', version: 'v2' },
    ];
    expect(decideChunkRevision(head, { status: 'stale', changed })).toEqual({
      action: 'synthesize',
      reason: 'head_invalidated',
      changed,
    });
  });

  it('neither stands by nor rewrites a head it cannot verify', () => {
    expect(decideChunkRevision(head, { status: 'unverifiable', unknown: [] })).toEqual({
      action: 'skip',
      reason: 'head_unverifiable',
    });
    expect(decideChunkRevision(head, undefined)).toEqual({
      action: 'skip',
      reason: 'head_unverifiable',
    });
  });
});

describe('where the required transition evidence is looked for', () => {
  it('separates the sources a change names from the endpoints behind one', () => {
    const revision = buildEvidenceRevision([
      { kind: 'source', id: 's1', scope: 'source.state', version: 'v1' },
      { kind: 'node', id: 'claim-9', scope: 'graph.node_state', version: 'v1' },
      {
        kind: 'relation_scope',
        id: 'claim-9',
        scope: 'sqlite:stated_correction:in',
        version: 'v1',
      },
    ]);
    expect(transitionEndpoints(revision.dependencies)).toEqual({
      sources: ['s1'],
      endpoints: ['claim-9'],
    });
  });
});
