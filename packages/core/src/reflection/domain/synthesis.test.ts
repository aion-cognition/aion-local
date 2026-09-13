import { describe, expect, it } from 'vitest';

import {
  parseSynthesisAnswer,
  plannedConclusions,
  synthesisNeighbourhoodKey,
  type PriorConclusion,
  type SynthesisPremise,
} from './synthesis.js';

const PREMISES: readonly SynthesisPremise[] = [
  { id: 'n-1', label: 'Decision', text: 'we moved the queue onto Valkey', revision: 1 },
  { id: 'n-2', label: 'Insight', text: 'the queue stalls above seven a minute', revision: 3 },
];

const PRIOR: PriorConclusion = {
  id: 'c-1',
  text: 'the stall is a storage problem',
  revision: 1,
  premiseIds: ['n-2'],
};

describe('synthesisNeighbourhoodKey', () => {
  it('folds the same premises in any order to one key', () => {
    const forward = synthesisNeighbourhoodKey('v9', PREMISES, [PRIOR]);
    const reversed = synthesisNeighbourhoodKey('v9', [...PREMISES].reverse(), [PRIOR]);

    expect(forward).toBe(reversed);
  });

  it('moves when a premise the pass selected has been revised since', () => {
    const before = synthesisNeighbourhoodKey('v9', PREMISES, []);
    const after = synthesisNeighbourhoodKey(
      'v9',
      PREMISES.map((premise) => (premise.id === 'n-2' ? { ...premise, revision: 4 } : premise)),
      [],
    );

    expect(after).not.toBe(before);
  });

  it('moves when a premise joins the neighbourhood', () => {
    const before = synthesisNeighbourhoodKey('v9', PREMISES, []);
    const after = synthesisNeighbourhoodKey(
      'v9',
      [...PREMISES, { id: 'n-3', label: 'Event', text: 'a third', revision: 1 }],
      [],
    );

    expect(after).not.toBe(before);
  });

  it('moves when a conclusion already drawn over the same premises is revised', () => {
    const before = synthesisNeighbourhoodKey('v9', PREMISES, [PRIOR]);
    const after = synthesisNeighbourhoodKey('v9', PREMISES, [{ ...PRIOR, revision: 2 }]);

    expect(after).not.toBe(before);
  });

  it('forks on the pipeline version, so a rebuilt pass reconsiders what the old one answered', () => {
    expect(synthesisNeighbourhoodKey('v9', PREMISES, [])).not.toBe(
      synthesisNeighbourhoodKey('v10', PREMISES, []),
    );
  });
});

describe('parseSynthesisAnswer', () => {
  it('keeps the conclusions it can read and counts the ones it cannot', () => {
    const parsed = parseSynthesisAnswer({
      conclusions: [
        { text: 'a conclusion', premises: ['M1'], inference: 'new', confidence: 0.7 },
        { text: 'no premises named', inference: 'new' },
      ],
    });

    expect(parsed.status).toBe('read');
    if (parsed.status !== 'read') {
      return;
    }
    expect(parsed.conclusions).toHaveLength(1);
    expect(parsed.dropped).toBe(1);
  });

  it('refuses a reply that is not a list of conclusions at all', () => {
    expect(parseSynthesisAnswer({ conclusions: 'none' }).status).toBe('unusable');
  });

  it('reads an empty list as a pass that concluded nothing', () => {
    const parsed = parseSynthesisAnswer({ conclusions: [] });

    expect(parsed).toEqual({ status: 'read', conclusions: [], dropped: 0 });
  });
});

describe('plannedConclusions', () => {
  const answer = (conclusions: readonly unknown[]): ReturnType<typeof parseSynthesisAnswer> =>
    parseSynthesisAnswer({ conclusions });

  function plan(conclusions: readonly unknown[], max = 3): ReturnType<typeof plannedConclusions> {
    const parsed = answer(conclusions);
    if (parsed.status !== 'read') {
      throw new Error('fixture answer must parse');
    }
    return plannedConclusions(parsed.conclusions, {
      premises: PREMISES,
      priors: [PRIOR],
      max,
    });
  }

  it('resolves premise tags to the node ids the pass selected', () => {
    const planned = plan([
      { text: 'the stall follows the move', premises: ['M1', 'M2'], inference: 'new' },
    ]);

    expect(planned.conclusions).toEqual([
      expect.objectContaining({
        text: 'the stall follows the move',
        premiseIds: ['n-1', 'n-2'],
        outcome: { kind: 'new' },
      }),
    ]);
  });

  it('plans a replacement against the prior conclusion the tag names', () => {
    const planned = plan([
      {
        text: 'the stall is a cadence problem',
        premises: ['M1', 'M2'],
        inference: 'replaces',
        revises: 'C1',
      },
    ]);

    expect(planned.conclusions[0]?.outcome).toEqual({ kind: 'replaces', priorId: 'c-1' });
  });

  it('plans an alternative that leaves the prior conclusion standing', () => {
    const planned = plan([
      {
        text: 'the stall is a storage problem under load',
        premises: ['M1', 'M2'],
        inference: 'alternative',
        revises: 'C1',
      },
    ]);

    expect(planned.conclusions[0]?.outcome).toEqual({ kind: 'alternative', priorId: 'c-1' });
  });

  it('refuses a revision that names no prior conclusion', () => {
    const planned = plan([{ text: 'floating revision', premises: ['M1'], inference: 'replaces' }]);

    expect(planned.conclusions).toEqual([]);
    expect(planned.refused).toEqual(['replaces names no prior conclusion this pass showed']);
  });

  it('refuses a revision whose prior conclusion this pass never showed the model', () => {
    const planned = plan([
      { text: 'invented target', premises: ['M1'], inference: 'replaces', revises: 'C9' },
    ]);

    expect(planned.conclusions).toEqual([]);
    expect(planned.refused).toEqual(['replaces names C9, which this pass did not show']);
  });

  it('refuses a conclusion whose premises are none of the ones it was shown', () => {
    const planned = plan([{ text: 'unsupported', premises: ['M9'], inference: 'new' }]);

    expect(planned.conclusions).toEqual([]);
    expect(planned.refused).toEqual(['new cites no premise this pass showed']);
  });

  it('plans a conclusion over the older memories the pass showed', () => {
    const planned = plan([
      { text: 'the stall predates the move', premises: ['M2'], inference: 'new' },
    ]);

    expect(planned.refused).toEqual([]);
    expect(planned.conclusions).toEqual([
      expect.objectContaining({ premiseIds: ['n-2'], outcome: { kind: 'new' } }),
    ]);
  });

  it('takes the first conclusions up to the cap and says how many it left', () => {
    const planned = plan(
      [
        { text: 'one', premises: ['M1'], inference: 'new' },
        { text: 'two', premises: ['M1'], inference: 'new' },
        { text: 'three', premises: ['M1'], inference: 'new' },
      ],
      2,
    );

    expect(planned.conclusions.map((entry) => entry.text)).toEqual(['one', 'two']);
    expect(planned.overflow).toBe(1);
  });
});
