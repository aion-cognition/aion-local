import { expect, it } from 'vitest';

import { fuse, type FusionResult } from './fusion.js';
import { buildRecallTrace, type RecallTrace } from './recall-trace.js';
import { CALIBRATED, candidate, list, RRF } from './test-support/fusion.fixture.js';

function run(arrivalScore: number): FusionResult {
  return fuse(
    [
      list('vector', [candidate('anchor', { relevance: 0.9 })]),
      list('graph_traversal', [
        candidate('arrival', {
          method: 'activation',
          relevance: 0,
          activation: 0.29,
          evidence: [{ method: 'vector', relevance: arrivalScore, cue: 'q' }],
        }),
      ]),
    ],
    { ...RRF, admission: CALIBRATED },
  );
}

function traceOf(result: FusionResult): RecallTrace {
  return buildRecallTrace({
    sessionId: 'reader',
    sampledAt: '2026-09-08T00:00:00Z',
    readMode: { code: 'default' },
    queryDigest: 'q',
    configDigest: 'c',
    route: {
      cueProvider: 'scripted',
      cueModel: 'scripted',
      cueReason: 'test',
      embedModel: 'scripted',
    },
    seedLegs: [{ strategy: 'vector', candidates: [{ id: 'anchor', score: 0.9, relevance: 0.9 }] }],
    activated: [{ nodeId: 'anchor' }, { nodeId: 'arrival' }],
    activationIterations: 1,
    activationNodesVisited: 2,
    activationTermination: 'frontier_exhausted',
    fused: result.items,
    admission: result.admission,
    preAssembly: result.items.map((item) => item.id),
    withheldOwn: new Set(),
    withheldRepeat: new Set(),
    foldEligible: [],
    foldedCount: 0,
    assemblyDecisions: [{ id: 'anchor', bucket: 'episodes', reason: 'accepted', rank: 1 }],
    emitted: new Set(['anchor']),
  });
}

it('preserves the measured arrival score even when both readings render to the same hundredth', () => {
  const first = run(0.591);
  const second = run(0.594);
  expect(first.admission).toMatchObject({ admitted: 1, droppedBelowFloor: 1 });
  expect(second.admission).toMatchObject({ admitted: 1, droppedBelowFloor: 1 });
  // The exact evidence changed under the same policy, while reason and display rounding did not.
  expect(traceOf(first)).not.toEqual(traceOf(second));
});

it('records the existing fused rank score separately from the cosine that admitted it', () => {
  const result = run(0.591);
  const item = result.items[0];
  expect(item).toBeDefined();
  expect(item?.score).not.toBe(item?.measured);
  // No field name is prescribed: the diagnostic must preserve this existing numeric value.
  expect(JSON.stringify(traceOf(result))).toContain(String(item?.score));
});
