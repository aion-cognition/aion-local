import { describe, expect, it } from 'vitest';

import {
  classifyHygieneAge,
  hygieneLedgerKey,
  isPastHygieneHorizon,
  proposalHygieneRelevance,
  type HygieneEpisodeSignal,
  type HygieneHorizons,
} from './proposal-hygiene.js';
import { healthFixture } from './test-support/health.fixture.js';

const CREATED_AT = new Date('2026-08-01T00:00:00.000Z');
const HORIZONS: HygieneHorizons = { pollutedHours: 24, residueDays: 14 };

function toolOnlyEpisode(occurredAt: Date = CREATED_AT): HygieneEpisodeSignal {
  return { occurredAt, turnCount: 0, toolExecutionCount: 3 };
}

function ordinaryEpisode(occurredAt: Date = CREATED_AT): HygieneEpisodeSignal {
  return { occurredAt, turnCount: 2, toolExecutionCount: 1 };
}

describe('classifyHygieneAge', () => {
  it('classes a turnless, tool-bearing episode as tooling exhaust', () => {
    expect(classifyHygieneAge(CREATED_AT, toolOnlyEpisode())).toBe('tooling_exhaust');
  });

  it('classes an episode with turns as ordinary residue, tool calls or not', () => {
    expect(classifyHygieneAge(CREATED_AT, ordinaryEpisode())).toBe('ordinary_residue');
  });

  it('classes a turnless episode with no tool calls as ordinary residue', () => {
    expect(
      classifyHygieneAge(CREATED_AT, {
        occurredAt: CREATED_AT,
        turnCount: 0,
        toolExecutionCount: 0,
      }),
    ).toBe('ordinary_residue');
  });

  it('falls through to ordinary residue when the episode is newer than the proposal', () => {
    const laterEpisode = toolOnlyEpisode(new Date('2026-08-02T00:00:00.000Z'));
    expect(classifyHygieneAge(CREATED_AT, laterEpisode)).toBe('ordinary_residue');
  });

  it('falls through to ordinary residue when no episode could be read', () => {
    expect(classifyHygieneAge(CREATED_AT, undefined)).toBe('ordinary_residue');
  });
});

describe('isPastHygieneHorizon', () => {
  it('is not past the fast horizon one hour short of it', () => {
    const now = new Date(CREATED_AT.getTime() + 23 * 3_600_000);
    expect(isPastHygieneHorizon(CREATED_AT, now, 'tooling_exhaust', HORIZONS)).toBe(false);
  });

  it('is past the fast horizon exactly on it', () => {
    const now = new Date(CREATED_AT.getTime() + 24 * 3_600_000);
    expect(isPastHygieneHorizon(CREATED_AT, now, 'tooling_exhaust', HORIZONS)).toBe(true);
  });

  it('is not past the ordinary horizon a day short of it', () => {
    const now = new Date(CREATED_AT.getTime() + 13 * 86_400_000);
    expect(isPastHygieneHorizon(CREATED_AT, now, 'ordinary_residue', HORIZONS)).toBe(false);
  });

  it('is past the ordinary horizon exactly on it', () => {
    const now = new Date(CREATED_AT.getTime() + 14 * 86_400_000);
    expect(isPastHygieneHorizon(CREATED_AT, now, 'ordinary_residue', HORIZONS)).toBe(true);
  });
});

describe('proposalHygieneRelevance', () => {
  it('is zero with nothing open', () => {
    const health = healthFixture({
      proposals: {
        supersessionOpen: 0,
        entityMergeOpen: 0,
        oldestOpenAgeMs: undefined,
        medianOpenAgeMs: undefined,
      },
    });
    expect(proposalHygieneRelevance(health)).toBe(0);
  });

  it('is zero when the oldest open row is still under the polluted horizon', () => {
    const health = healthFixture({
      proposals: {
        supersessionOpen: 1,
        entityMergeOpen: 0,
        oldestOpenAgeMs: 3_600_000,
        medianOpenAgeMs: 3_600_000,
      },
    });
    expect(proposalHygieneRelevance(health)).toBe(0);
  });

  it('scales toward one as the oldest row approaches the residue horizon', () => {
    const sevenDaysMs = 7 * 86_400_000;
    const health = healthFixture({
      proposals: {
        supersessionOpen: 0,
        entityMergeOpen: 2,
        oldestOpenAgeMs: sevenDaysMs,
        medianOpenAgeMs: sevenDaysMs,
      },
    });
    expect(proposalHygieneRelevance(health)).toBeCloseTo(0.5, 5);
  });

  it('caps at one past the residue horizon', () => {
    const health = healthFixture({
      proposals: {
        supersessionOpen: 0,
        entityMergeOpen: 1,
        oldestOpenAgeMs: 60 * 86_400_000,
        medianOpenAgeMs: 60 * 86_400_000,
      },
    });
    expect(proposalHygieneRelevance(health)).toBe(1);
  });
});

describe('hygieneLedgerKey', () => {
  it('names the table and the proposal id', () => {
    expect(hygieneLedgerKey('supersession', 'sp-1')).toBe('proposal_hygiene:supersession:sp-1');
    expect(hygieneLedgerKey('entity_merge', 'em-1')).toBe('proposal_hygiene:entity_merge:em-1');
  });
});
