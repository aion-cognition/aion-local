import { describe, expect, it } from 'vitest';

import {
  parseTypeCounts,
  recordTypeObservations,
  reconcileType,
  serializeTypeCounts,
  squashName,
  type TypeCounts,
} from './entity-reconciliation.js';

describe('squashName', () => {
  it('lands every separator spelling of one name on one key', () => {
    const keys = [
      'proposal hygiene',
      'proposal-hygiene',
      'proposal_hygiene',
      'proposal.hygiene',
      'proposal/hygiene',
      'proposal--hygiene',
    ].map((name) => squashName(name));

    expect(new Set(keys)).toEqual(new Set(['proposalhygiene']));
  });

  it('folds first, so a raw name and its name_norm squash the same', () => {
    expect(squashName('  Proposal   Hygiene ')).toBe(squashName('proposal hygiene'));
    expect(squashName('Ａion-ＤB')).toBe('aiondb');
  });

  it('keeps the digits that tell one instance from another', () => {
    expect(squashName('beta-episode-1')).toBe('betaepisode1');
    expect(squashName('beta-episode-2')).toBe('betaepisode2');
  });

  it('answers empty for a name that is nothing but separators', () => {
    expect(squashName(' -_./ ')).toBe('');
    expect(squashName('')).toBe('');
  });
});

describe('parseTypeCounts', () => {
  it('round-trips what it serialized', () => {
    const counts: TypeCounts = { project: 3, tool: 1 };
    expect(parseTypeCounts(serializeTypeCounts(counts))).toEqual(counts);
  });

  it('answers empty for a property that is absent or not a counted map', () => {
    for (const raw of [undefined, null, '', 'not json', '[]', '3', '"project"', 7]) {
      expect(parseTypeCounts(raw)).toEqual({});
    }
  });

  it('drops a count for vocabulary the taxonomy no longer has', () => {
    expect(parseTypeCounts('{"concept":9,"project":1}')).toEqual({ project: 1 });
  });

  it('drops a count that is not a whole number of observations', () => {
    expect(parseTypeCounts('{"project":0,"tool":-2,"person":1.5,"topic":"4","event":2}')).toEqual({
      event: 2,
    });
  });

  it('serializes in taxonomy order, so an unchanged map writes the same string twice', () => {
    expect(serializeTypeCounts({ tool: 1, project: 2 })).toBe(
      serializeTypeCounts({ project: 2, tool: 1 }),
    );
  });
});

describe('recordTypeObservations', () => {
  it('counts one observation per distinct type the extraction gave', () => {
    expect(recordTypeObservations({}, ['project', 'tool'])).toEqual({ project: 1, tool: 1 });
  });

  it('accumulates onto what the node already carries', () => {
    expect(recordTypeObservations({ project: 2 }, ['project'])).toEqual({ project: 3 });
  });

  it('leaves the counts it was given alone', () => {
    const before: TypeCounts = { project: 1 };
    recordTypeObservations(before, ['tool']);
    expect(before).toEqual({ project: 1 });
  });
});

describe('reconcileType', () => {
  it('gives the label to the most observed type', () => {
    expect(reconcileType('tool', { project: 4, tool: 1 })).toBe('project');
  });

  it('keeps the incumbent on a tie, so a label does not flip on equal evidence', () => {
    expect(reconcileType('tool', { project: 3, tool: 3 })).toBe('tool');
  });

  it('keeps the incumbent when nothing has been observed at all', () => {
    expect(reconcileType('person', {})).toBe('person');
  });

  it('lets one observation beat an incumbent that has none', () => {
    expect(reconcileType('topic', { person: 1 })).toBe('person');
  });

  it('answers the same whatever order the stored map was written in', () => {
    expect(reconcileType('topic', parseTypeCounts('{"tool":2,"project":2}'))).toBe(
      reconcileType('topic', parseTypeCounts('{"project":2,"tool":2}')),
    );
  });
});
