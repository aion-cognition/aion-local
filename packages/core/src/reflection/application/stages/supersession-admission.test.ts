import { beforeEach, afterEach, it, expect } from 'vitest';

import { SupersessionTestBed, seedFactNode } from './supersession.fixture.js';
import { SupersessionStage } from './supersession.js';
import {
  EvidenceResolver,
  CheckedJudgmentEvidence,
} from '../../../evidence/application/resolver.js';
import {
  checkedContext,
  seedSource,
  commitIncidence,
  establishScope,
  establishNodeState,
} from '../../../evidence/test-support/evidence.fixture.js';

const bed = new SupersessionTestBed();
beforeEach(() => {
  bed.open();
});
afterEach(() => {
  bed.close();
});
it('keeps a final over-allowance pair owed when another pair receives an ordinary answer', async () => {
  const name = 'a'.repeat(3500);
  const texts = [`${name} new value`, `${name} old value`, 'a separate prior decision'];
  const episodes = ['episode-new', 'episode-big', 'episode-small'];
  const nodes = ['claim-new', 'claim-big', 'claim-small'];
  for (let i = 0; i < 3; i++) {
    bed.seedEpisode(episodes[i]!);
    seedFactNode(bed.graph, {
      id: nodes[i]!,
      label: 'Decision',
      text: texts[i]!,
      vector: [1, 0],
      episodeId: episodes[i]!,
    });
    seedSource(bed.db, {
      sourceId: episodes[i]!,
      sessionId: 'session',
      identity: 'review',
      content: { turns: [{ role: 'user', text: texts[i]! }] },
      turnIds: [`turn-${i}`],
      now: bed.now,
    });
    commitIncidence(bed.db, {
      sourceId: episodes[i]!,
      nodeId: nodes[i]!,
      role: 'extraction',
      operationId: `extract-${i}`,
      at: bed.now,
    });
    for (const scope of ['sqlite:extraction:out', 'sqlite:stated_correction:in']) {
      establishScope(bed.db, nodes[i]!, scope, bed.now);
    }
    establishScope(bed.db, episodes[i]!, 'sqlite:mention:out', bed.now);
    establishNodeState(bed.db, nodes[i]!, { revision: 1, at: bed.now });
  }
  bed.graph.seedNode('shared-entity', ['AionNode', 'Entity'], { name, name_norm: name });
  bed.graph.seedEdge('MENTIONS', 'episode-new', 'shared-entity');
  bed.graph.seedEdge('MENTIONS', 'episode-big', 'shared-entity');
  const resolver = new EvidenceResolver({
    driver: bed.graph.driver,
    db: bed.db,
    logger: { warn: () => undefined },
    publications: {
      checkpoint: async () => ({
        status: 'ready',
        checkpoint: {
          substrateId: 'review',
          protocolVersion: 1,
          sequence: '1',
          operationId: null,
          intentDigest: null,
          resultDigest: null,
        },
      }),
    },
  });
  const real = new CheckedJudgmentEvidence({ resolver, context: checkedContext({ now: bed.now }) });
  const statuses: string[] = [];
  bed.responses = [{ contradicts: false, confidence: 0 }];
  const outcome = await new SupersessionStage({
    mode: 'unanimous',
    maxNeighbors: 2,
    maxJudgments: 2,
  }).run({
    ...bed.context('episode-new'),
    evidence: {
      assemble: async (pair) => {
        const result = await real.assemble(pair);
        statuses.push(result.status);
        return result;
      },
      confirm: (revision) => real.confirm(revision),
    },
  });
  expect.soft(statuses).toEqual(['assembled', 'assembled']);
  expect.soft(bed.requests).toHaveLength(1);
  expect.soft(outcome.retryable).toBe(true);
  expect.soft(outcome.withheldWork?.length).toBeGreaterThan(0);
});
