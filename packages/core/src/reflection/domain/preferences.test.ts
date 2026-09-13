import { describe, expect, it } from 'vitest';

import {
  parsePreferenceAnswer,
  plannedPreferences,
  preferenceSignalKey,
  type PreferenceSignal,
  type StandingPreference,
} from './preferences.js';

const SIGNALS: readonly PreferenceSignal[] = [
  { id: 't-1', role: 'user', text: 'show me the dry run before you touch prod', echo: false },
  { id: 't-2', role: 'assistant', text: 'here is the dry run', echo: false },
];

const STANDING: StandingPreference = {
  id: 'p-1',
  text: 'wants a dry run before any destructive command',
  revision: 1,
  scope: 'standing',
  groundIds: ['t-0'],
};

describe('preferenceSignalKey', () => {
  it('folds the signals of one episode to one key whatever order they arrive in', () => {
    expect(preferenceSignalKey('v9', 'e-1', SIGNALS, [STANDING])).toBe(
      preferenceSignalKey('v9', 'e-1', [...SIGNALS].reverse(), [STANDING]),
    );
  });

  it('moves when a standing preference this pass read has been revised', () => {
    expect(preferenceSignalKey('v9', 'e-1', SIGNALS, [{ ...STANDING, revision: 2 }])).not.toBe(
      preferenceSignalKey('v9', 'e-1', SIGNALS, [STANDING]),
    );
  });

  it('separates two episodes carrying the same words', () => {
    expect(preferenceSignalKey('v9', 'e-1', SIGNALS, [])).not.toBe(
      preferenceSignalKey('v9', 'e-2', SIGNALS, []),
    );
  });
});

describe('parsePreferenceAnswer', () => {
  it('keeps what it can read and counts what it cannot', () => {
    const parsed = parsePreferenceAnswer({
      preferences: [
        { text: 'wants dry runs', grounds: ['S1'], scope: 'standing' },
        { text: 'no grounds named' },
      ],
    });

    expect(parsed.status).toBe('read');
    if (parsed.status !== 'read') {
      return;
    }
    expect(parsed.preferences).toHaveLength(1);
    expect(parsed.dropped).toBe(1);
  });

  it('refuses a reply that is not a list of preferences', () => {
    expect(parsePreferenceAnswer({ preferences: 7 }).status).toBe('unusable');
  });
});

describe('plannedPreferences', () => {
  function plan(preferences: readonly unknown[], max = 3): ReturnType<typeof plannedPreferences> {
    const parsed = parsePreferenceAnswer({ preferences });
    if (parsed.status !== 'read') {
      throw new Error('fixture answer must parse');
    }
    return plannedPreferences(parsed.preferences, { signals: SIGNALS, standing: [STANDING], max });
  }

  it('resolves ground tags to signal ids and keeps their recorded roles', () => {
    const planned = plan([{ text: 'wants dry runs first', grounds: ['S1'], scope: 'standing' }]);

    expect(planned.preferences).toEqual([
      expect.objectContaining({
        text: 'wants dry runs first',
        groundIds: ['t-1'],
        roles: ['user'],
        scope: 'standing',
        outcome: { kind: 'new' },
      }),
    ]);
  });

  it('keeps a contextual preference contextual, with the context it named', () => {
    const planned = plan([
      {
        text: 'wants terse output',
        grounds: ['S1'],
        scope: 'contextual',
        context: 'while pairing on an incident',
      },
    ]);

    expect(planned.preferences[0]).toEqual(
      expect.objectContaining({ scope: 'contextual', context: 'while pairing on an incident' }),
    );
  });

  it('reads a contextual preference that names no context as standing nothing, and refuses it', () => {
    const planned = plan([{ text: 'wants terse output', grounds: ['S1'], scope: 'contextual' }]);

    expect(planned.preferences).toEqual([]);
    expect(planned.refused).toEqual(['a contextual preference that names no context']);
  });

  it('plans a revision against the standing preference the tag names', () => {
    const planned = plan([
      { text: 'wants dry runs only on prod', grounds: ['S1'], scope: 'standing', revises: 'P1' },
    ]);

    expect(planned.preferences[0]?.outcome).toEqual({ kind: 'replaces', priorId: 'p-1' });
  });

  it('refuses a revision naming a preference this pass did not show', () => {
    const planned = plan([
      { text: 'invented target', grounds: ['S1'], scope: 'standing', revises: 'P9' },
    ]);

    expect(planned.refused).toEqual(['a revision of P9, which this pass did not show']);
  });

  it('refuses a preference grounded only in signals that echo what the substrate already holds', () => {
    const parsed = parsePreferenceAnswer({
      preferences: [{ text: 'wants dry runs', grounds: ['S1'], scope: 'standing' }],
    });
    if (parsed.status !== 'read') {
      throw new Error('fixture answer must parse');
    }

    const planned = plannedPreferences(parsed.preferences, {
      signals: [{ ...SIGNALS[0]!, echo: true }],
      standing: [STANDING],
      max: 3,
    });

    expect(planned.preferences).toEqual([]);
    expect(planned.refused).toEqual([
      'a preference grounded only in the substrate repeating itself',
    ]);
  });

  it('takes the first preferences up to the cap', () => {
    const planned = plan(
      [
        { text: 'one', grounds: ['S1'], scope: 'standing' },
        { text: 'two', grounds: ['S1'], scope: 'standing' },
      ],
      1,
    );

    expect(planned.preferences.map((entry) => entry.text)).toEqual(['one']);
    expect(planned.overflow).toBe(1);
  });
});
