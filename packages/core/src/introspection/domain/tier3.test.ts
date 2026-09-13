import { describe, expect, it } from 'vitest';

import type { OperationCandidate } from './decide.js';
import type { HealthSnapshot, OperationEffectiveness } from './health.js';
import { healthFixture } from './test-support/health.fixture.js';
import {
  acceptTier3Proposal,
  blendedConfidence,
  executionWeight,
  NEUTRAL_EFFECTIVENESS_PRIOR,
  proposalWeight,
  proposeOnlyAdvisor,
  TIER3_DENIED_OPERATIONS,
  type Tier3Proposal,
} from './tier3.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';

const FLOOR = DEFAULTS.maintenance.tier3AcceptanceFloor;

const CANDIDATES: readonly OperationCandidate[] = [
  { name: 'dead_letter', relevance: 0.18 },
  { name: 'symbiosis_bridge', relevance: 0.15 },
  { name: 'episode_evict', relevance: 0.12 },
  { name: 'memory_decay', relevance: 0 },
];

function effectiveness(
  name: string,
  overrides: Partial<OperationEffectiveness> = {},
): OperationEffectiveness {
  return {
    name,
    runs: 3,
    improved: 3,
    failed: 0,
    effectiveness: 1,
    cyclesSinceSelected: 4,
    lastRunAt: undefined,
    meanDurationMs: undefined,
    ...overrides,
  };
}

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return healthFixture({
    effectiveness: [effectiveness('dead_letter'), effectiveness('symbiosis_bridge')],
    ...overrides,
  });
}

function proposal(operation: string, confidence = 0.8): Tier3Proposal {
  return { operation, confidence, rationale: 'the queue is holding exhausted rows' };
}

describe('blendedConfidence', () => {
  it('weights confidence by what the operation has done for the substrate', () => {
    expect(blendedConfidence(0.8, 0.5)).toBeCloseTo(0.4);
  });

  it('reads an unscored operation at the neutral prior rather than at zero', () => {
    expect(blendedConfidence(0.8, undefined)).toBeCloseTo(0.8 * NEUTRAL_EFFECTIVENESS_PRIOR);
  });
});

describe('executionWeight', () => {
  it('reads a record of nothing at the neutral prior', () => {
    expect(executionWeight(0, 0)).toBeCloseTo(NEUTRAL_EFFECTIVENESS_PRIOR);
  });

  /** An unmeasured success is unknown rather than good, so a clean record only ever reads neutral. */
  it('cannot be raised past neutral by runs nothing scored', () => {
    expect(executionWeight(20, 0)).toBe(NEUTRAL_EFFECTIVENESS_PRIOR);
  });

  it('falls under the neutral prior once runs have failed', () => {
    expect(executionWeight(5, 5)).toBeLessThan(NEUTRAL_EFFECTIVENESS_PRIOR);
    expect(executionWeight(5, 5)).toBeCloseTo(0.1429, 4);
  });

  /** One bad tick costs an operation cycles; it does not end it. */
  it('leaves a single failure recoverable', () => {
    const afterOne = executionWeight(1, 1);
    expect(afterOne).toBeGreaterThan(executionWeight(5, 5));
    expect(executionWeight(11, 1)).toBeGreaterThan(afterOne);
    expect(executionWeight(11, 1)).toBeCloseTo(0.4615, 4);
  });
});

describe('proposalWeight', () => {
  it('passes the reading of a declared metric through untouched', () => {
    expect(proposalWeight(effectiveness('edge_prune', { effectiveness: 0.9 }))).toBe(0.9);
  });

  it('falls to the run record where no metric could score one', () => {
    expect(
      proposalWeight(
        effectiveness('community_refresh', { effectiveness: undefined, runs: 5, failed: 5 }),
      ),
    ).toBeCloseTo(executionWeight(5, 5));
  });

  it('reads an operation with no row at all at the cold-start prior', () => {
    expect(proposalWeight(undefined)).toBe(NEUTRAL_EFFECTIVENESS_PRIOR);
  });
});

describe('acceptTier3Proposal', () => {
  it('accepts a candidate with work to do and a record behind it', () => {
    expect(acceptTier3Proposal(proposal('dead_letter'), CANDIDATES, snapshot(), FLOOR)).toEqual({
      verdict: 'accepted',
      candidate: CANDIDATES.find((entry) => entry.name === 'dead_letter'),
      blended: 0.8,
      weight: 1,
    });
  });

  it('accepts the bridge, which the deterministic tier could already schedule', () => {
    expect(
      acceptTier3Proposal(proposal('symbiosis_bridge'), CANDIDATES, snapshot(), FLOOR),
    ).toMatchObject({ verdict: 'accepted' });
  });

  it('accepts an operation nothing has scored, on the neutral prior', () => {
    const untried = snapshot({ effectiveness: [] });

    expect(acceptTier3Proposal(proposal('dead_letter'), CANDIDATES, untried, FLOOR)).toMatchObject({
      verdict: 'accepted',
      blended: 0.4,
    });
  });

  it('downgrades a confident recommendation for an operation whose runs stopped helping', () => {
    const poor = snapshot({
      effectiveness: [effectiveness('dead_letter', { effectiveness: 0.2, improved: 1, runs: 5 })],
    });

    expect(acceptTier3Proposal(proposal('dead_letter', 1), CANDIDATES, poor, FLOOR)).toMatchObject({
      verdict: 'downgraded',
      blended: 0.2,
    });
  });

  /**
   * The measureless path, which is where the whole catalog's unscored majority lives. Nothing
   * in the snapshot can say a `symbiosis_bridge` helped, so its successes buy it nothing; its
   * failures are still evidence, and five of them are not a cold start.
   */
  describe('an operation with no metric', () => {
    function bridge(overrides: Partial<OperationEffectiveness>): HealthSnapshot {
      return snapshot({
        effectiveness: [
          effectiveness('symbiosis_bridge', { effectiveness: undefined, ...overrides }),
        ],
      });
    }

    it('is actionable on a cold start', () => {
      expect(
        acceptTier3Proposal(
          proposal('symbiosis_bridge', 0.9),
          CANDIDATES,
          bridge({ runs: 0, improved: 0, failed: 0 }),
          FLOOR,
        ),
      ).toMatchObject({ verdict: 'accepted', weight: NEUTRAL_EFFECTIVENESS_PRIOR, blended: 0.45 });
    });

    it('is downgraded once its runs have failed', () => {
      const gate = acceptTier3Proposal(
        proposal('symbiosis_bridge', 0.9),
        CANDIDATES,
        bridge({ runs: 5, improved: 0, failed: 5 }),
        FLOOR,
      );

      expect(gate).toMatchObject({ verdict: 'downgraded' });
      expect(gate.verdict === 'downgraded' && gate.blended).toBeLessThan(
        0.9 * NEUTRAL_EFFECTIVENESS_PRIOR,
      );
      expect(gate.verdict === 'downgraded' && gate.reason).toContain(
        '5 failures in 5 unscored runs',
      );
    });

    it('is actionable again once clean runs outweigh the failures', () => {
      expect(
        acceptTier3Proposal(
          proposal('symbiosis_bridge', 0.9),
          CANDIDATES,
          bridge({ runs: 15, improved: 0, failed: 5 }),
          FLOOR,
        ),
      ).toMatchObject({ verdict: 'accepted' });
    });
  });

  it('downgrades an operation that cannot be taken back', () => {
    expect(
      acceptTier3Proposal(proposal('episode_evict'), CANDIDATES, snapshot(), FLOOR),
    ).toMatchObject({
      verdict: 'downgraded',
      reason: 'the operation cannot be taken back',
    });
  });

  it('rejects an operation the cycle never offered', () => {
    expect(
      acceptTier3Proposal(proposal('vector_backfill'), CANDIDATES, snapshot(), FLOOR),
    ).toMatchObject({
      verdict: 'rejected',
      reason: 'the operation is not a candidate on this cycle',
    });
  });

  it('rejects a candidate whose own relevance says there is nothing to do', () => {
    expect(
      acceptTier3Proposal(proposal('memory_decay'), CANDIDATES, snapshot(), FLOOR),
    ).toMatchObject({
      verdict: 'rejected',
      reason: 'the operation reports no work to do',
    });
  });

  /**
   * The scoped refusal. Missing evidence blocks the actions that need it, which is what a
   * relevance of zero says; it does not block an operation reading a collector that answered.
   */
  it('accepts an operation with work to do while another collector is degraded', () => {
    const degraded = snapshot({ degraded: ['graph'] });

    expect(acceptTier3Proposal(proposal('dead_letter'), CANDIDATES, degraded, FLOOR)).toMatchObject(
      { verdict: 'accepted' },
    );
  });

  it('rejects the operation whose own evidence is the collector that failed', () => {
    const degraded = snapshot({
      degraded: ['graph'],
      // What a graph-reading operation's own relevance returns on a snapshot it cannot read.
      effectiveness: [effectiveness('symbiosis_bridge')],
    });
    const candidates: readonly OperationCandidate[] = [
      { name: 'symbiosis_bridge', relevance: 0 },
      ...CANDIDATES.filter((entry) => entry.name !== 'symbiosis_bridge'),
    ];

    expect(
      acceptTier3Proposal(proposal('symbiosis_bridge'), candidates, degraded, FLOOR),
    ).toMatchObject({ verdict: 'rejected', reason: 'the operation reports no work to do' });
  });
});

describe('TIER3_DENIED_OPERATIONS', () => {
  it('names only what no command puts back', () => {
    expect([...TIER3_DENIED_OPERATIONS].sort()).toEqual([
      'episode_evict',
      'redaction_residue_purge',
    ]);
  });
});

describe('proposeOnlyAdvisor', () => {
  it('declines rather than recommending, so an unwired loop still records the consultation', async () => {
    const logger = openLogger({ filePath: '/dev/null', level: 'error' });
    const outcome = await proposeOnlyAdvisor(logger)({
      health: snapshot(),
      candidates: CANDIDATES,
      reason: 'no operation cleared the urgency threshold',
    });

    expect(outcome.status).toBe('declined');
  });
});
