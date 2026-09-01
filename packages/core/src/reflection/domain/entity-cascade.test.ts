import { describe, expect, it } from 'vitest';

import { isDeterministicRelation, nameFormRelation } from './entity-cascade.js';

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
