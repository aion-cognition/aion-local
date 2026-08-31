import { describe, expect, it } from 'vitest';

import type { OperationCandidate } from './decide.js';
import type { HealthSnapshot, OperationEffectiveness } from './health.js';
import { healthFixture } from './test-support/health.fixture.js';
import { acceptTier3Proposal, proposeOnlyAdvisor, type Tier3Proposal } from './tier3.js';
import { openLogger } from '../../infrastructure/logging/logger.js';

const CANDIDATES: readonly OperationCandidate[] = [
  { name: 'dead_letter', relevance: 0.18 },
  { name: 'symbiosis_bridge', relevance: 0.15 },
  { name: 'memory_decay', relevance: 0 },
];

function effectiveness(name: string, runs: number): OperationEffectiveness {
  return {
    name,
    runs,
    improved: runs,
    failed: 0,
    effectiveness: 1,
    cyclesSinceSelected: 4,
    lastRunAt: undefined,
  };
}

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return healthFixture({
    effectiveness: [effectiveness('dead_letter', 3), effectiveness('symbiosis_bridge', 2)],
    ...overrides,
  });
}

function proposal(operation: string): Tier3Proposal {
  return { operation, confidence: 0.8, rationale: 'the queue is holding exhausted rows' };
}

describe('acceptTier3Proposal', () => {
  it('accepts an allowlisted candidate with work to do and a record of running', () => {
    expect(acceptTier3Proposal(proposal('dead_letter'), CANDIDATES, snapshot())).toEqual({
      verdict: 'accepted',
    });
  });

  it('rejects every proposal while the snapshot is degraded, whatever else holds', () => {
    const degraded = snapshot({ degraded: ['graph'] });

    expect(acceptTier3Proposal(proposal('dead_letter'), CANDIDATES, degraded)).toMatchObject({
      verdict: 'rejected',
    });
  });

  it('rejects an operation the cycle never offered', () => {
    expect(acceptTier3Proposal(proposal('vector_backfill'), CANDIDATES, snapshot())).toMatchObject({
      verdict: 'rejected',
      reason: 'the operation is not a candidate on this cycle',
    });
  });

  it('rejects a candidate whose own relevance says there is nothing to do', () => {
    expect(acceptTier3Proposal(proposal('memory_decay'), CANDIDATES, snapshot())).toMatchObject({
      verdict: 'rejected',
      reason: 'the operation reports no work to do',
    });
  });

  it('downgrades an operation outside the act allowlist', () => {
    expect(acceptTier3Proposal(proposal('symbiosis_bridge'), CANDIDATES, snapshot())).toMatchObject(
      {
        verdict: 'downgraded',
        reason: 'the operation is outside the act allowlist',
      },
    );
  });

  it('downgrades an operation that has never resolved a run', () => {
    const untried = snapshot({ effectiveness: [effectiveness('dead_letter', 0)] });

    expect(acceptTier3Proposal(proposal('dead_letter'), CANDIDATES, untried)).toMatchObject({
      verdict: 'downgraded',
      reason: 'the operation has never been seen to succeed',
    });
  });

  it('downgrades an operation with no effectiveness row at all', () => {
    const missing = snapshot({ effectiveness: [] });

    expect(acceptTier3Proposal(proposal('dead_letter'), CANDIDATES, missing)).toMatchObject({
      verdict: 'downgraded',
      reason: 'the operation has never been seen to succeed',
    });
  });

  it('reads the degraded snapshot before the allowlist, so a degraded cycle never downgrades', () => {
    const degraded = snapshot({ degraded: ['queue'], effectiveness: [] });

    expect(acceptTier3Proposal(proposal('symbiosis_bridge'), CANDIDATES, degraded)).toMatchObject({
      verdict: 'rejected',
    });
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
