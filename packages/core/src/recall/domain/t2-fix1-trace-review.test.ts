import { expect, it } from 'vitest';

import { fuse, type FusionResult } from './fusion.js';
import { buildRecallTrace, type RecallTrace } from './recall-trace.js';
import { CALIBRATED, candidate, list, RRF } from './test-support/fusion.fixture.js';

function run(measuredId: string): FusionResult {
  return fuse(
    [
      list('vector', [candidate('anchor', { relevance: 0.9 })]),
      list(
        'graph_traversal',
        ['a', 'b'].map((id) =>
          candidate(id, {
            method: 'activation',
            relevance: 0,
            activation: 0.29,
            evidence: id === measuredId ? [{ method: 'vector', relevance: 0.2, cue: 'q' }] : [],
          }),
        ),
      ),
    ],
    { ...RRF, admission: CALIBRATED },
  );
}

function traceOf(result: FusionResult): RecallTrace {
  return buildRecallTrace({
    sessionId: 'reader',
    sampledAt: '2026-09-08T00:00:00Z',
    readMode: { code: 'default' },
    queryDigest: 'query',
    configDigest: 'config',
    route: {
      cueProvider: 'scripted',
      cueModel: 'scripted',
      cueReason: 'test',
      embedModel: 'scripted',
    },
    seedLegs: [{ strategy: 'vector', candidates: [{ id: 'anchor', score: 0.9, relevance: 0.9 }] }],
    activated: [{ nodeId: 'anchor' }, { nodeId: 'a' }, { nodeId: 'b' }],
    activationIterations: 1,
    activationNodesVisited: 3,
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

it('distinguishes which activation arrival was below floor and which was unmeasured', () => {
  const measuredA = run('a');
  const measuredB = run('b');
  expect(measuredA.admission).toMatchObject({
    admitted: 1,
    droppedBelowFloor: 1,
    droppedUnmeasured: 1,
    droppedUnmeasuredArrival: 1,
  });
  expect(measuredA.admission).toEqual(measuredB.admission);
  // Only the arrival evidence swaps. A comparison must retain the distinct rejection reasons.
  expect(traceOf(measuredA)).not.toEqual(traceOf(measuredB));
});
