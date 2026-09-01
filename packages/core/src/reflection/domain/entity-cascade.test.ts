import { describe, expect, it } from 'vitest';

import {
  describeEntityPairFacts,
  isDeterministicRelation,
  nameFormRelation,
} from './entity-cascade.js';

describe('nameFormRelation', () => {
  it('reads two spellings of one folded name as fold equality', () => {
    expect(nameFormRelation('PostgreSQL', 'postgresql')).toBe('fold');
    // The fold keeps diacritics on purpose, so this pair meets on case alone.
    expect(nameFormRelation('Zoë Müller', 'zoë müller')).toBe('fold');
  });

  it('reads a separator variant as squash equality', () => {
    expect(nameFormRelation('re-mark', 'remark')).toBe('squash');
    expect(nameFormRelation('aion_local', 'aion local')).toBe('squash');
    expect(nameFormRelation('github.com/aion', 'github com aion')).toBe('squash');
  });

  it('keeps the digit guard on the squash arm', () => {
    expect(nameFormRelation('beta-episode-1', 'beta episode 2')).toBe('none');
  });

  it('reads a containment or near-spelling as bigram overlap and nothing stronger', () => {
    expect(nameFormRelation('Postgres', 'PostgreSQL')).toBe('bigram');
    expect(nameFormRelation('Sarah Chen', 'Chen')).toBe('bigram');
    expect(nameFormRelation('Aion', 'The Aion Substrate')).toBe('bigram');
  });

  it.each([
    ['Redis', 'Redix'],
    ['github-token', 'gitlab-token'],
    ['beta episode 1', 'beta episode 2'],
    ['Project Helios', 'QUASARFLANGE7741'],
    ['remittance ingest', 'remittance reconciliation service'],
    ['🌊', '🛰'],
    ['naïve', 'café'],
    ['api', 'rapid'],
  ])('reads %s against %s as no relation at all', (left, right) => {
    expect(nameFormRelation(left, right)).toBe('none');
  });

  it('reads an empty name as no relation, whatever it is compared against', () => {
    expect(nameFormRelation('', '')).toBe('none');
    expect(nameFormRelation('', 'Aion')).toBe('none');
  });
});

describe('isDeterministicRelation', () => {
  it('admits only the two relations tier 0 may act on without a judge', () => {
    expect(isDeterministicRelation('fold')).toBe(true);
    expect(isDeterministicRelation('squash')).toBe(true);
    expect(isDeterministicRelation('bigram')).toBe(false);
    expect(isDeterministicRelation('none')).toBe(false);
  });
});

describe('describeEntityPairFacts', () => {
  const BASE = {
    leftName: 'Postgres',
    rightName: 'PostgreSQL',
    relation: 'bigram' as const,
    leftMentionCount: 4,
    rightMentionCount: 1,
  };

  it('states every measured signal as its own sentence', () => {
    const facts = describeEntityPairFacts({
      ...BASE,
      signals: {
        sharedEpisodeCount: 2,
        neighborOverlapCount: 3,
        temporalGapDays: 0,
        leftEpisodeCount: 4,
        rightEpisodeCount: 1,
      },
    });

    expect(facts).toEqual([
      expect.stringContaining('share most of their characters'),
      'They are mentioned together in 2 episodes of the 3 episodes that mention either.',
      'They are both connected to 3 other nodes.',
      'Their closest mentions are 0.0 days apart.',
      'Postgres is mentioned in 4 episodes, PostgreSQL in 1 episode.',
    ]);
  });

  it('says an absent signal is absent rather than reporting a zero for it', () => {
    const facts = describeEntityPairFacts({
      ...BASE,
      signals: {
        sharedEpisodeCount: 0,
        neighborOverlapCount: 0,
        leftEpisodeCount: 4,
        rightEpisodeCount: 1,
      },
    });

    expect(facts).toContain('No episode mentions both of them.');
    expect(facts).toContain('They are connected to none of the same nodes.');
    expect(facts).toContain(
      'Neither has a dated mention, so nothing says how far apart they were seen.',
    );
  });

  it('says so when the pair read returned nothing at all', () => {
    const facts = describeEntityPairFacts(BASE);

    expect(facts).toEqual([
      expect.stringContaining('share most of their characters'),
      'Nothing about the two together could be measured in the graph.',
    ]);
  });

  it('never states the nominating cosine, whatever the caller measured', () => {
    const facts = describeEntityPairFacts({
      ...BASE,
      signals: {
        sharedEpisodeCount: 1,
        neighborOverlapCount: 0,
        temporalGapDays: 12.25,
        leftEpisodeCount: 4,
        rightEpisodeCount: 1,
      },
    });

    expect(facts.join(' ')).not.toMatch(/cosine|similarity|0\.9/);
  });
});
