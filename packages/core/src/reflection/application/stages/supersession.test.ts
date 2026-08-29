import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedFactNode, SupersessionTestBed } from './supersession.fixture.js';
import { SupersessionStage } from './supersession.js';

const EPISODE_ID = 'episode-2';
const PRIOR_EPISODE_ID = 'episode-1';

/** Two near-parallel unit vectors: cosine ≈ 0.99, comfortably over the neighbour threshold. */
const CLOSE = [1, 0.1, 0];
const ALSO_CLOSE = [1, 0.14, 0];
const FAR = [0, 1, 0];

const bed = new SupersessionTestBed();

/** One prior Decision and one new Decision that sits next to it in embedding space. */
function seedContradictingPair(): void {
  bed.seedEpisode(PRIOR_EPISODE_ID);
  bed.seedEpisode(EPISODE_ID);
  seedFactNode(bed.graph, {
    id: 'decision-old',
    label: 'Decision',
    text: 'Queue writes stay in the main Postgres transaction.',
    vector: CLOSE,
    episodeId: PRIOR_EPISODE_ID,
  });
  seedFactNode(bed.graph, {
    id: 'decision-new',
    label: 'Decision',
    text: 'Queue writes move to a separate SQLite database.',
    vector: ALSO_CLOSE,
    episodeId: EPISODE_ID,
  });
}

beforeEach(() => {
  bed.open();
});

afterEach(() => {
  bed.close();
});

describe('SupersessionStage', () => {
  it('skips an episode with no fact-bearing nodes', async () => {
    bed.seedEpisode(EPISODE_ID);

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.status).toBe('skipped');
    expect(bed.requests).toHaveLength(0);
  });

  it('skips fact nodes that have no content vector yet', async () => {
    bed.seedEpisode(EPISODE_ID);
    seedFactNode(bed.graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'A decision whose embedding has not landed.',
      episodeId: EPISODE_ID,
    });

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toContain('content vectors');
    expect(bed.requests).toHaveLength(0);
  });

  it('proposes rather than supersedes by default, however sure the judgment is', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: true, confidence: 1, rationale: 'the new decision reverses it' }];

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 1 });
    expect(bed.graph.closeStatements()).toEqual([]);
    expect(bed.validUntil('decision-old')).toBeUndefined();
    expect(bed.supersedesEdges()).toEqual([]);
    expect(bed.proposals()[0]).toMatchObject({
      oldId: 'decision-old',
      newId: 'decision-new',
      confidence: 1,
      rationale: 'the new decision reverses it',
      episodeId: EPISODE_ID,
      createdAt: bed.now.toISOString(),
      resolvedAt: null,
    });
  });

  it('names the mode in its summary', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: false, confidence: 0 }];

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.summary).toContain('propose mode');
  });

  it('supersedes in auto mode when the judgment clears the threshold', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: true, confidence: 0.92, rationale: 'the new decision reverses it' }];

    const outcome = await new SupersessionStage({ mode: 'auto' }).run(bed.context(EPISODE_ID));

    expect(outcome.counts).toEqual({ supersessions: 1, supersessionProposals: 0 });
    expect(bed.validUntil('decision-old')).toBeDefined();
    expect(bed.supersedesEdges()).toEqual([{ sourceId: 'decision-new', targetId: 'decision-old' }]);
    expect(bed.proposals()).toEqual([]);
  });

  it('proposes in auto mode below the threshold', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: true, confidence: 0.6, rationale: 'possibly a reversal' }];

    const outcome = await new SupersessionStage({ mode: 'auto' }).run(bed.context(EPISODE_ID));

    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 1 });
    expect(bed.validUntil('decision-old')).toBeUndefined();
    expect(bed.supersedesEdges()).toEqual([]);
    expect(bed.proposals()[0]?.confidence).toBe(0.6);
  });

  it('treats a confidence exactly at the threshold as an auto-apply in auto mode', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: true, confidence: 0.85 }];

    const outcome = await new SupersessionStage({ mode: 'auto' }).run(bed.context(EPISODE_ID));

    expect(outcome.counts?.supersessions).toBe(1);
    expect(bed.proposals()).toEqual([]);
  });

  it('records the unstated confidence a model omits', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: true }];

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 1 });
    expect(bed.proposals()[0]?.confidence).toBe(0.5);
  });

  it('writes nothing when the model says the pair does not contradict', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: false, confidence: 0.9 }];

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 0 });
    expect(bed.validUntil('decision-old')).toBeUndefined();
    expect(bed.proposals()).toEqual([]);
  });

  it('never judges an episode against its own siblings', async () => {
    bed.seedEpisode(EPISODE_ID);
    seedFactNode(bed.graph, {
      id: 'decision-a',
      label: 'Decision',
      text: 'A decision.',
      vector: CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(bed.graph, {
      id: 'decision-b',
      label: 'Decision',
      text: 'B decision.',
      vector: ALSO_CLOSE,
      episodeId: EPISODE_ID,
    });

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(bed.requests).toHaveLength(0);
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 0 });
  });

  it('ignores a neighbour that is already superseded or too far away', async () => {
    bed.seedEpisode(EPISODE_ID);
    seedFactNode(bed.graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'The new decision.',
      vector: CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(bed.graph, {
      id: 'decision-closed',
      label: 'Decision',
      text: 'Already superseded.',
      vector: ALSO_CLOSE,
      episodeId: PRIOR_EPISODE_ID,
      superseded: true,
    });
    seedFactNode(bed.graph, {
      id: 'decision-unrelated',
      label: 'Decision',
      text: 'About something else entirely.',
      vector: FAR,
      episodeId: PRIOR_EPISODE_ID,
    });

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(bed.requests).toHaveLength(0);
    expect(outcome.status).toBe('ok');
  });

  it('bounds the run at maxJudgments however many close neighbours exist', async () => {
    bed.seedEpisode(EPISODE_ID);
    for (let index = 0; index < 4; index += 1) {
      seedFactNode(bed.graph, {
        id: `decision-new-${index}`,
        label: 'Decision',
        text: `New decision ${index}.`,
        vector: CLOSE,
        episodeId: EPISODE_ID,
      });
      seedFactNode(bed.graph, {
        id: `decision-prior-${index}`,
        label: 'Decision',
        text: `Prior decision ${index}.`,
        vector: ALSO_CLOSE,
        episodeId: PRIOR_EPISODE_ID,
      });
    }

    const outcome = await new SupersessionStage({ maxJudgments: 3, maxNeighbors: 2 }).run(
      bed.context(EPISODE_ID),
    );

    expect(bed.requests).toHaveLength(3);
    expect(outcome.status).toBe('ok');
  });

  it('bounds the subjects it checks', async () => {
    bed.seedEpisode(EPISODE_ID);
    for (let index = 0; index < 4; index += 1) {
      seedFactNode(bed.graph, {
        id: `decision-new-${index}`,
        label: 'Decision',
        text: `New decision ${index}.`,
        vector: CLOSE,
        episodeId: EPISODE_ID,
      });
    }
    seedFactNode(bed.graph, {
      id: 'decision-prior',
      label: 'Decision',
      text: 'The one prior decision.',
      vector: ALSO_CLOSE,
      episodeId: PRIOR_EPISODE_ID,
    });

    await new SupersessionStage({ maxSubjects: 2 }).run(bed.context(EPISODE_ID));

    expect(bed.requests).toHaveLength(2);
  });

  it('sends one judgment per pair, with both statements, the kinds, and thinking off', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: false, confidence: 0.1 }];

    await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(bed.requests).toHaveLength(1);
    expect(bed.requests[0]!.think).toBe(false);
    expect(bed.requests[0]!.signal).toBeDefined();
    const prompt = bed.prompts()[0]!;
    expect(prompt).toContain('Queue writes stay in the main Postgres transaction.');
    expect(prompt).toContain('Queue writes move to a separate SQLite database.');
    expect(prompt).toContain('kind Decision');
  });

  it('carries the false-bait discipline in the prompt', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: false, confidence: 0.1 }];

    await new SupersessionStage().run(bed.context(EPISODE_ID));

    const prompt = bed.prompts()[0]!;
    expect(prompt).toContain('different subjects');
    expect(prompt).toContain('restates, summarises, or rephrases');
    expect(prompt).toContain('different times');
    expect(prompt).toContain('two people disagreeing');
  });

  it('fails when every judgment fails, and writes nothing', async () => {
    seedContradictingPair();
    bed.responses = [new Error('ollama unreachable')];

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('judgment');
    expect(bed.validUntil('decision-old')).toBeUndefined();
    expect(bed.proposals()).toEqual([]);
  });

  it('keeps going when one judgment of several fails', async () => {
    bed.seedEpisode(EPISODE_ID);
    seedFactNode(bed.graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'The new decision.',
      vector: CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(bed.graph, {
      id: 'decision-prior-a',
      label: 'Decision',
      text: 'Prior decision A.',
      vector: ALSO_CLOSE,
      episodeId: PRIOR_EPISODE_ID,
    });
    seedFactNode(bed.graph, {
      id: 'decision-prior-b',
      label: 'Decision',
      text: 'Prior decision B.',
      vector: CLOSE,
      episodeId: PRIOR_EPISODE_ID,
    });
    bed.responses = [new Error('one bad call'), { contradicts: true, confidence: 0.9 }];

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.supersessionProposals).toBe(1);
  });

  it('fails on a shape the judgment schema rejects', async () => {
    seedContradictingPair();
    bed.responses = [{ verdict: 'yes' }];

    const outcome = await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(outcome.status).toBe('failed');
    expect(bed.proposals()).toEqual([]);
  });

  it('re-running after an auto-supersession judges nothing and writes nothing new', async () => {
    seedContradictingPair();
    bed.responses = [{ contradicts: true, confidence: 0.92 }];
    await new SupersessionStage({ mode: 'auto' }).run(bed.context(EPISODE_ID));

    const before = bed.supersedesEdges();
    bed.requests = [];
    const outcome = await new SupersessionStage({ mode: 'auto' }).run(bed.context(EPISODE_ID));

    expect(bed.requests).toHaveLength(0);
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 0 });
    expect(bed.supersedesEdges()).toEqual(before);
  });

  it('re-running after a proposal leaves one proposal row', async () => {
    seedContradictingPair();
    bed.responses = [
      { contradicts: true, confidence: 0.6, rationale: 'possibly' },
      { contradicts: true, confidence: 0.6, rationale: 'possibly' },
    ];

    await new SupersessionStage().run(bed.context(EPISODE_ID));
    await new SupersessionStage().run(bed.context(EPISODE_ID));

    expect(bed.proposals()).toHaveLength(1);
  });
});
