import { describe, expect, it } from 'vitest';

import type { AdmissionReport } from './admission.js';
import {
  buildRecallTrace,
  emittedSubsetVerdict,
  emittedWithinCandidates,
  traceIds,
  type RecallTraceInput,
} from './recall-trace.js';

const ADMISSION: AdmissionReport = {
  policy: { vectorFloor: 0.5, corroborationFloor: 0.3, bm25Mode: 'corroborated' },
  considered: 4,
  admitted: 2,
  droppedBelowFloor: 1,
  droppedUnmeasured: 1,
  droppedUnmeasuredArrival: 0,
  droppedDuplicateContent: 0,
  droppedNearDuplicate: 0,
  anchored: true,
  typedAdmitted: 0,
};

function input(overrides: Partial<RecallTraceInput> = {}): RecallTraceInput {
  return {
    sessionId: 'session-1',
    sampledAt: '2026-09-07T00:00:00.000Z',
    readMode: { code: 'default' },
    queryDigest: 'q',
    configDigest: 'c',
    route: {
      cueProvider: 'ollama',
      cueModel: 'qwen3:8b',
      cueReason: 'local-default',
      embedModel: 'snowflake',
    },
    seedLegs: [
      {
        strategy: 'vector',
        candidates: [
          { id: 'a', score: 0.9, relevance: 0.8 },
          { id: 'b', score: 0.4, relevance: 0.3 },
        ],
      },
      { strategy: 'bm25', candidates: [] },
    ],
    activated: [{ nodeId: 'a' }, { nodeId: 'c' }],
    activationIterations: 2,
    activationNodesVisited: 9,
    activationTermination: 'frontier_exhausted',
    fused: [{ id: 'a' }, { id: 'b' }],
    admission: ADMISSION,
    preAssembly: ['a', 'b', 'c', 'd'],
    withheldOwn: new Set(['c']),
    withheldRepeat: new Set(['d']),
    foldEligible: ['a', 'b'],
    foldedCount: 1,
    assemblyDecisions: [
      { id: 'a', bucket: 'episodes', reason: 'accepted', rank: 1 },
      { id: 'b', bucket: 'episodes', reason: 'folded', standsInFor: 'a' },
      { id: 'd', bucket: 'episodes', reason: 'token_budget' },
    ],
    emitted: new Set(['a']),
    ...overrides,
  };
}

describe('bounding an id set', () => {
  it('keeps the total and says it was cut', () => {
    const set = traceIds(['a', 'b', 'c'], 2);
    expect(set).toEqual({ ids: ['a', 'b'], total: 3, truncated: true });
  });

  it('does not claim truncation on a set that fits', () => {
    expect(traceIds(['a'], 2)).toEqual({ ids: ['a'], total: 1, truncated: false });
  });
});

describe('the stage trace', () => {
  it('records each seed leg with its own best numbers', () => {
    const trace = buildRecallTrace(input());
    const [vector, bm25] = trace.seedLegs;
    expect(vector).toMatchObject({ strategy: 'vector', bestScore: 0.9, bestRelevance: 0.8 });
    expect(vector?.candidates.ids).toEqual(['a', 'b']);
    expect(bm25?.candidates.total).toBe(0);
    expect(bm25?.bestScore).toBe(undefined);
  });

  it('carries the activation run beside the ids it reached', () => {
    const trace = buildRecallTrace(input());
    expect(trace.activation).toMatchObject({
      ids: ['a', 'c'],
      iterations: 2,
      nodesVisited: 9,
      termination: 'frontier_exhausted',
    });
  });

  it('reports the admission gate as the run reported it', () => {
    expect(buildRecallTrace(input()).admission).toBe(ADMISSION);
  });

  it('leaves the two named subtractions out of the remainder', () => {
    const trace = buildRecallTrace(input());
    expect(trace.withheldOwn.ids).toEqual(['c']);
    expect(trace.withheldRepeat.ids).toEqual(['d']);
    expect(trace.withheldRemainder.ids).toEqual(['b']);
  });

  it('reports the fold as the count assembly kept and the eligibility it decided', () => {
    const trace = buildRecallTrace(input());
    expect(trace.foldedCount).toBe(1);
    expect(trace.foldEligible.ids).toEqual(['a', 'b']);
  });

  it('names which candidate folded, behind which twin, apart from a budget rejection', () => {
    const trace = buildRecallTrace(input());
    expect(trace.assemblyDecisions).toEqual([
      { id: 'a', bucket: 'episodes', reason: 'accepted', rank: 1 },
      { id: 'b', bucket: 'episodes', reason: 'folded', standsInFor: 'a' },
      { id: 'd', bucket: 'episodes', reason: 'token_budget' },
    ]);
    expect(trace.assemblyDecisionsTruncated).toBe(false);
  });

  it('keeps the per-candidate scores of each leg, not only its maximum', () => {
    const [vector] = buildRecallTrace(input()).seedLegs;
    expect(vector?.scored).toEqual([
      { id: 'a', score: 0.9, relevance: 0.8 },
      { id: 'b', score: 0.4, relevance: 0.3 },
    ]);
  });

  it('carries the vantage clocks rather than only a name for the mode', () => {
    const trace = buildRecallTrace(
      input({ readMode: { code: 'as_of', validAt: '2026-03-01T00:00:00.000Z' } }),
    );
    expect(trace.readMode).toEqual({ code: 'as_of', validAt: '2026-03-01T00:00:00.000Z' });
  });

  it('carries the route the run resolved rather than a configured alias', () => {
    expect(buildRecallTrace(input()).route.cueReason).toBe('local-default');
  });

  it('holds no query text, only its digest', () => {
    const trace = buildRecallTrace(input({ queryDigest: 'deadbeef' }));
    expect(JSON.stringify(trace)).not.toContain('what did we decide');
    expect(trace.queryDigest).toBe('deadbeef');
  });
});

describe('reading emitted against what was offered', () => {
  it('accepts a pack whose ids all reached assembly', () => {
    expect(emittedWithinCandidates(buildRecallTrace(input()))).toBe(true);
  });

  it('rejects a pack holding an id no stage nominated', () => {
    const trace = buildRecallTrace(input({ emitted: new Set(['a', 'never-seen']) }));
    expect(emittedWithinCandidates(trace)).toBe(false);
  });

  it('reports indeterminate rather than success on a truncated set', () => {
    const trace = buildRecallTrace(input({ emitted: new Set(['never-seen']) }), 0);
    expect(trace.preAssembly.truncated).toBe(true);
    expect(emittedSubsetVerdict(trace)).toBe('indeterminate');
    expect(emittedWithinCandidates(trace)).toBe(false);
  });
});
