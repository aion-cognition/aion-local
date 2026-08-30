import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedEntity, seedFactNode, SupersessionTestBed } from './supersession.fixture.js';
import { SupersessionStage } from './supersession.js';

/**
 * Candidate generation and the six-case contradiction battery. The judgments are mocked, so
 * what these assert is which pairs the stage chooses to spend a judgment on and what it
 * writes afterwards, the half of supersession measured broken in both directions.
 */

const EPISODE_ID = 'episode-2';

const CLOSE = [1, 0.1, 0];
const ALSO_CLOSE = [1, 0.14, 0];
const FAR = [0, 1, 0];

const bed = new SupersessionTestBed();

beforeEach(() => {
  bed.open();
});

afterEach(() => {
  bed.close();
});

describe('SupersessionStage candidate generation', () => {
  /**
   * A measured false closure: a payments-worker retry policy closed by a Stripe
   * webhook change, on shared vocabulary alone. The claim naming the same subject is the one
   * worth a judgment even when a different subject sits closer in embedding space.
   */
  function seedSubjectAndDistractor(): void {
    bed.seedEpisode(EPISODE_ID);
    bed.seedEpisode('episode-stripe-prior');
    bed.seedEpisode('episode-payments-prior');
    seedEntity(bed.graph, {
      id: 'entity-stripe',
      name: 'Stripe',
      type: 'organization',
      mentionedBy: [EPISODE_ID, 'episode-stripe-prior'],
    });
    seedFactNode(bed.graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'Raise the Stripe webhook retry limit from 3 to 7 attempts.',
      vector: CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(bed.graph, {
      id: 'concept-stripe-prior',
      label: 'Concept',
      text: 'The Stripe webhook retry limit is 3 attempts.',
      vector: FAR,
      episodeId: 'episode-stripe-prior',
    });
    seedFactNode(bed.graph, {
      id: 'decision-payments-prior',
      label: 'Decision',
      text: 'The retry backoff was capped at four attempts to prevent duplicate captures.',
      vector: ALSO_CLOSE,
      episodeId: 'episode-payments-prior',
    });
  }

  it('judges the claim that names the same subject, not the closer neighbour', async () => {
    seedSubjectAndDistractor();
    bed.responses = [{ contradicts: true, confidence: 0.9, rationale: 'the limit changed' }];

    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(bed.context(EPISODE_ID));

    expect(bed.requests).toHaveLength(1);
    const prompt = bed.prompts()[0]!;
    expect(prompt).toContain('The Stripe webhook retry limit is 3 attempts.');
    expect(prompt).not.toContain('duplicate captures');
    expect(prompt).toContain('Both statements name: stripe');
    expect(outcome.counts?.supersessionProposals).toBe(1);
    expect(bed.proposals()[0]?.oldId).toBe('concept-stripe-prior');
  });

  it('crosses labels, because a baseline lands in Concept and its correction in Decision', async () => {
    seedSubjectAndDistractor();
    bed.responses = [{ contradicts: true, confidence: 0.9 }];

    await new SupersessionStage({ maxNeighbors: 1 }).run(bed.context(EPISODE_ID));

    expect(bed.prompts()[0]).toContain('kind Concept');
    expect(bed.prompts()[0]).toContain('kind Decision');
  });

  it('reports which leg found the pair', async () => {
    seedSubjectAndDistractor();
    bed.responses = [{ contradicts: true, confidence: 0.9 }];

    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(bed.context(EPISODE_ID));

    expect(outcome.summary).toContain('1 by shared subject');
  });

  it('widens to embedding proximity when no entity names the subject', async () => {
    bed.seedEpisode(EPISODE_ID);
    bed.seedEpisode('episode-prior');
    seedFactNode(bed.graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'Queue writes move to a separate SQLite database.',
      vector: ALSO_CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(bed.graph, {
      id: 'decision-old',
      label: 'Decision',
      text: 'Queue writes stay in the main Postgres transaction.',
      vector: CLOSE,
      episodeId: 'episode-prior',
    });
    bed.responses = [{ contradicts: true, confidence: 0.9 }];

    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(bed.context(EPISODE_ID));

    expect(bed.requests).toHaveLength(1);
    expect(bed.prompts()[0]).toContain('Queue writes stay in the main Postgres transaction.');
    expect(bed.prompts()[0]).not.toContain('Both statements name:');
    expect(outcome.summary).toContain('0 by shared subject');
  });

  it('leaves an entity too short to identify a subject out of the subject leg', async () => {
    bed.seedEpisode(EPISODE_ID);
    bed.seedEpisode('episode-short-prior');
    seedEntity(bed.graph, {
      id: 'entity-s3',
      name: 's3',
      type: 'tool',
      mentionedBy: [EPISODE_ID, 'episode-short-prior'],
    });
    seedFactNode(bed.graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'Artifacts move to s3 storage.',
      vector: CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(bed.graph, {
      id: 'concept-short-prior',
      label: 'Concept',
      text: 'Nothing here mentions the same subject at all.',
      vector: FAR,
      episodeId: 'episode-short-prior',
    });

    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(bed.context(EPISODE_ID));

    expect(bed.requests).toHaveLength(0);
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 0 });
  });
});

type BatteryCase = {
  readonly key: string;
  readonly entity: string;
  /** False where the bait's whole point is that the prior does not share the subject. */
  readonly priorNamesSubject: boolean;
  readonly prior: string;
  readonly next: string;
  readonly contradicts: boolean;
};

const BATTERY: readonly BatteryCase[] = [
  {
    key: 'retry',
    entity: 'Stripe',
    priorNamesSubject: true,
    prior: 'The Stripe webhook retry limit is 3 attempts.',
    next: 'The Stripe webhook retry limit is raised to 7 attempts.',
    contradicts: true,
  },
  {
    key: 'deploy',
    entity: 'billing service',
    priorNamesSubject: true,
    prior: 'The billing service deploys to AWS us-east-1.',
    next: 'The billing service deploys to Fly.io now, not AWS.',
    contradicts: true,
  },
  {
    key: 'merge',
    entity: 'Ryan',
    priorNamesSubject: true,
    prior: 'Ryan prefers squash merges on every pull request.',
    next: 'Ryan prefers merge commits over squash merges, for bisectability.',
    contradicts: true,
  },
  {
    key: 'timeout',
    entity: 'Twilio',
    priorNamesSubject: true,
    prior: 'The Twilio SMS callback has a timeout of 30 seconds.',
    next: 'The Twilio SMS callback timeout is cut to 10 seconds.',
    contradicts: true,
  },
  {
    key: 'bait-subject',
    entity: 'payments worker',
    priorNamesSubject: false,
    prior: 'The retry backoff was capped at four attempts to prevent duplicate captures.',
    next: 'The payments worker retry ceiling is raised to seven attempts.',
    contradicts: false,
  },
  {
    key: 'bait-temporal',
    entity: 'reconciliation job',
    priorNamesSubject: true,
    prior: 'The reconciliation job ran for four hours on the July close.',
    next: 'The reconciliation job now takes forty minutes, after the new index.',
    contradicts: false,
  },
];

/** One near-orthogonal axis per case, so a case's KNN neighbours are its own pair only. */
function axis(index: number, jitter: number): number[] {
  const vector = new Array<number>(BATTERY.length).fill(0);
  vector[index] = 1;
  vector[(index + 1) % BATTERY.length] = jitter;
  return vector;
}

/**
 * The six-case battery with the verdicts mocked, so this asserts the write side:
 * four genuine corrections become proposal rows, the different-subject and temporal baits
 * become nothing, and no case closes a node.
 */
describe('SupersessionStage contradiction battery', () => {
  beforeEach(() => {
    bed.seedEpisode(EPISODE_ID);
    BATTERY.forEach((testCase, index) => {
      const priorEpisodeId = `episode-prior-${testCase.key}`;
      bed.seedEpisode(priorEpisodeId);
      seedEntity(bed.graph, {
        id: `entity-${testCase.key}`,
        name: testCase.entity,
        type: 'concept',
        mentionedBy: testCase.priorNamesSubject ? [EPISODE_ID, priorEpisodeId] : [EPISODE_ID],
      });
      seedFactNode(bed.graph, {
        id: `prior-${testCase.key}`,
        label: 'Concept',
        text: testCase.prior,
        vector: axis(index, 0.1),
        episodeId: priorEpisodeId,
      });
      seedFactNode(bed.graph, {
        id: `next-${testCase.key}`,
        label: 'Decision',
        text: testCase.next,
        vector: axis(index, 0.14),
        episodeId: EPISODE_ID,
      });
      bed.verdicts.push({
        match: testCase.prior,
        verdict: {
          contradicts: testCase.contradicts,
          confidence: 1,
          rationale: `${testCase.key} judgment`,
        },
      });
    });
  });

  it('proposes the four genuine corrections and nothing for the two baits', async () => {
    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(bed.context(EPISODE_ID));

    expect(outcome.status).toBe('ok');
    expect(bed.requests).toHaveLength(BATTERY.length);
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 4 });

    const pairs = bed.proposals().map((row) => [row.oldId, row.newId]);
    expect(pairs.sort()).toEqual(
      [
        ['prior-deploy', 'next-deploy'],
        ['prior-merge', 'next-merge'],
        ['prior-retry', 'next-retry'],
        ['prior-timeout', 'next-timeout'],
      ].sort(),
    );
  });

  it('closes nothing, whatever the judge answered', async () => {
    await new SupersessionStage({ maxNeighbors: 1 }).run(bed.context(EPISODE_ID));

    expect(bed.graph.closeStatements()).toEqual([]);
    expect(bed.supersedesEdges()).toEqual([]);
    for (const testCase of BATTERY) {
      expect(bed.validUntil(`prior-${testCase.key}`)).toBeUndefined();
    }
  });

  it('reaches the different-subject bait through the widener, not the subject leg', async () => {
    const outcome = await new SupersessionStage({ maxNeighbors: 1 }).run(bed.context(EPISODE_ID));

    expect(outcome.summary).toContain('4 by shared subject');
    const baitPrompt = bed.prompts().find((prompt) => prompt.includes('duplicate captures'));
    expect(baitPrompt).toBeDefined();
    expect(baitPrompt).not.toContain('Both statements name:');
  });
});
