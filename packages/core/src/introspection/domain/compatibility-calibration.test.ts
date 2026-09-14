import { describe, expect, it } from 'vitest';

import {
  describeCompatibilityCalibration,
  summarizeCompatibilityCalibration,
  type BridgeTraversalRecord,
} from './compatibility-calibration.js';
import type { PublishedBridge } from '../../infrastructure/graph/bridge-queries.js';

const NOW = new Date('2026-09-14T00:00:00.000Z');
const DAY_MS = 86_400_000;

function bridge(overrides: Partial<PublishedBridge> = {}): PublishedBridge {
  return {
    id: 'bridge-1',
    author: 'model',
    compatibility: 0.8,
    createdAt: new Date(NOW.getTime() - DAY_MS),
    ...overrides,
  };
}

describe('summarizeCompatibilityCalibration', () => {
  it('reports an empty population for a substrate with no published bridge', () => {
    const summary = summarizeCompatibilityCalibration([], [], NOW);

    expect(summary).toEqual({ asOf: NOW.toISOString(), totalPublished: 0, groups: [] });
  });

  it('separates model-authored bridges from deterministic ones into their own groups', () => {
    const summary = summarizeCompatibilityCalibration(
      [
        bridge({ id: 'model-1', author: 'model' }),
        bridge({ id: 'deterministic-1', author: 'deterministic', compatibility: undefined }),
      ],
      [],
      NOW,
    );

    expect(summary.groups.map((group) => group.author)).toEqual(['deterministic', 'model']);
    expect(summary.groups.map((group) => group.published)).toEqual([1, 1]);
  });

  it('counts a bridge with no traversal record at all as missing data, not as unused', () => {
    const summary = summarizeCompatibilityCalibration([bridge({ id: 'untouched' })], [], NOW);

    const [group] = summary.groups;
    expect(group).toMatchObject({ published: 1, observed: 0, crossed: 0, missingData: 1 });
  });

  it('folds every record for one bridge into a single observed entry, crossed once any walk crossed it', () => {
    const records: readonly BridgeTraversalRecord[] = [
      { bridgeId: 'bridge-1', crossed: false },
      { bridgeId: 'bridge-1', crossed: true },
      { bridgeId: 'bridge-1', crossed: false },
    ];

    const summary = summarizeCompatibilityCalibration([bridge({ id: 'bridge-1' })], records, NOW);

    expect(summary.groups[0]).toMatchObject({
      published: 1,
      observed: 1,
      crossed: 1,
      missingData: 0,
    });
  });

  it('excludes a traversal record naming a bridge no longer published', () => {
    const records: readonly BridgeTraversalRecord[] = [
      { bridgeId: 'forgotten-bridge', crossed: true },
    ];

    const summary = summarizeCompatibilityCalibration([bridge({ id: 'bridge-1' })], records, NOW);

    expect(summary.groups[0]).toMatchObject({ observed: 0, crossed: 0, missingData: 1 });
  });

  it("carries age and the author's own compatibility reading for the median", () => {
    const summary = summarizeCompatibilityCalibration(
      [bridge({ id: 'a', compatibility: 0.6, createdAt: new Date(NOW.getTime() - DAY_MS) })],
      [],
      NOW,
    );

    expect(summary.groups[0]?.ageMs).toEqual([DAY_MS]);
    expect(summary.groups[0]?.compatibility).toEqual([0.6]);
  });
});

describe('describeCompatibilityCalibration', () => {
  it('states that traversal is a usefulness observation, not proof the judgment was right', () => {
    const summary = summarizeCompatibilityCalibration([bridge()], [], NOW);

    const lines = describeCompatibilityCalibration(summary);
    expect(lines[0]).toContain('not independent proof the compatibility judgment was right');
    expect(lines[0]).toContain('not penalized');
  });

  it('reports nothing observed rather than an error for an empty substrate', () => {
    expect(
      describeCompatibilityCalibration(summarizeCompatibilityCalibration([], [], NOW)),
    ).toEqual(['compatibility calibration: no published bridges yet']);
  });
});
