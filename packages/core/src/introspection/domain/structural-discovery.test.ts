import { describe, expect, it } from 'vitest';

import { secondNomination, strongestNameRelation } from './structural-discovery.js';
import type { EntityPairSignals } from '../../infrastructure/graph/entity-signal-queries.js';

/**
 * The seconding rule on its own, away from the graph that produces the evidence. A cosine
 * brings a pair here and nothing else does; what leaves with an edge is what one of the three
 * graph readings also stands behind.
 */

function signals(overrides: Partial<EntityPairSignals> = {}): EntityPairSignals {
  return {
    leftId: 'left',
    rightId: 'right',
    sharedEpisodeIds: [],
    sharedEpisodeCount: 0,
    sharedEpisodeJaccard: 0,
    neighborOverlapCount: 0,
    neighborOverlapJaccard: 0,
    leftEpisodeCount: 3,
    rightEpisodeCount: 4,
    ...overrides,
  };
}

describe('secondNomination', () => {
  it('seconds a pair that was named in the same episode', () => {
    const seconds = secondNomination({
      signals: signals({ sharedEpisodeIds: ['ep-1'], sharedEpisodeCount: 1 }),
      leftForms: ['retry policy'],
      rightForms: ['backoff window'],
    });

    expect(seconds).toEqual(['shared_episode']);
  });

  it('seconds a pair that shares a neighbour', () => {
    const seconds = secondNomination({
      signals: signals({ neighborOverlapCount: 2 }),
      leftForms: ['retry policy'],
      rightForms: ['backoff window'],
    });

    expect(seconds).toEqual(['shared_neighbor']);
  });

  it('seconds a pair whose names differ only in the separators they are spelled with', () => {
    const seconds = secondNomination({
      signals: signals(),
      leftForms: ['proposal-hygiene'],
      rightForms: ['proposal hygiene sweep', 'proposal_hygiene'],
    });

    expect(seconds).toEqual(['name_overlap']);
  });

  it('returns nothing for a pair carrying a cosine and no graph evidence at all', () => {
    const seconds = secondNomination({
      signals: signals(),
      leftForms: ['retry policy'],
      rightForms: ['backoff window'],
    });

    expect(seconds).toEqual([]);
  });

  it('returns nothing when character overlap is all the two names have', () => {
    const seconds = secondNomination({
      signals: signals(),
      leftForms: ['Postgres'],
      rightForms: ['PostgreSQL'],
    });

    expect(strongestNameRelation(['Postgres'], ['PostgreSQL'])).toBe('bigram');
    expect(seconds).toEqual([]);
  });

  it('reads absent signals as no evidence rather than as zero evidence', () => {
    const seconds = secondNomination({
      leftForms: ['proposal-hygiene'],
      rightForms: ['proposal_hygiene'],
    });

    expect(seconds).toEqual(['name_overlap']);
  });

  it('names every reading that stands behind the pair, in one order', () => {
    const seconds = secondNomination({
      signals: signals({
        sharedEpisodeIds: ['ep-1'],
        sharedEpisodeCount: 1,
        neighborOverlapCount: 1,
      }),
      leftForms: ['proposal-hygiene'],
      rightForms: ['proposal_hygiene'],
    });

    expect(seconds).toEqual(['shared_episode', 'shared_neighbor', 'name_overlap']);
  });
});
