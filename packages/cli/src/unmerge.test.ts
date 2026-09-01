import { describe, expect, it } from 'vitest';

import { describeUnmergedDecision, parseUnmergeFlags, renderAbsorbed } from './unmerge.js';

describe('parseUnmergeFlags', () => {
  it('lists what one canonical entity absorbed', () => {
    expect(parseUnmergeFlags(['ls', 'entity-1'])).toEqual({
      subcommand: 'ls',
      id: 'entity-1',
      yes: false,
    });
  });

  it('applies against the absorbed id, which is what the merge record names', () => {
    expect(parseUnmergeFlags(['apply', 'entity-2'])).toEqual({
      subcommand: 'apply',
      id: 'entity-2',
      yes: false,
    });
  });

  it('reads --yes on either side of the id', () => {
    expect(parseUnmergeFlags(['apply', 'entity-2', '--yes']).yes).toBe(true);
    expect(parseUnmergeFlags(['apply', '--yes', 'entity-2']).yes).toBe(true);
  });

  it('refuses either subcommand with no id', () => {
    expect(() => parseUnmergeFlags(['ls'])).toThrow('unmerge ls needs a canonical entity id');
    expect(() => parseUnmergeFlags(['apply'])).toThrow(
      'unmerge apply needs the absorbed entity id',
    );
  });

  it('refuses a subcommand it does not have', () => {
    expect(() => parseUnmergeFlags(['split', 'entity-1'])).toThrow(
      "unknown unmerge subcommand 'split' (supported: ls, apply)",
    );
  });
});

describe('renderAbsorbed', () => {
  it('lists each merged identity with its name, type and edge count', () => {
    const lines: string[] = [];

    renderAbsorbed(
      'canonical-1',
      [
        {
          mergedId: 'merged-1',
          mergedName: 'PostgreSQL',
          mergedType: 'tool',
          mergedAliases: [],
          edges: [
            {
              type: 'RELATED_TO',
              direction: 'out',
              otherId: 'concept-1',
              strength: 0.7,
              confidence: 0.7,
              count: 1,
              signals: [],
              provenance: [],
            },
          ],
          raw: {},
        },
      ],
      (line) => lines.push(line),
    );

    expect(lines).toEqual([
      'canonical-1 has absorbed 1 identity(ies)',
      '  merged-1  PostgreSQL (tool), 1 edge(s) recorded',
    ]);
  });

  it('names what a record does not carry, rather than printing nothing', () => {
    const lines: string[] = [];

    renderAbsorbed(
      'canonical-1',
      [{ mergedId: 'merged-1', mergedAliases: [], edges: [], raw: {} }],
      (line) => lines.push(line),
    );

    expect(lines[1]).toBe('  merged-1  name not recorded (type not recorded), 0 edge(s) recorded');
  });
});

describe('describeUnmergedDecision', () => {
  it('names the tier that merged and every reason it recorded', () => {
    expect(
      describeUnmergedDecision({
        id: 'decision-1',
        tier: 'tier0',
        reasons: ['both names squash to aionlocal'],
      }),
    ).toBe('merged by tier0: both names squash to aionlocal');
  });

  it('says a record with no reasons has none rather than printing an empty tail', () => {
    expect(describeUnmergedDecision({ id: 'decision-2', tier: 'tier3', reasons: [] })).toBe(
      'merged by tier3: no reason recorded',
    );
  });
});
