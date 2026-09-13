import { describe, expect, it } from 'vitest';

import { adviseTier3 } from './tier3-advisor.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { AnthropicProvider } from '../../infrastructure/providers/anthropic-provider.js';
import type { ApiCall } from '../../infrastructure/providers/types.js';
import type { OperationCandidate } from '../domain/decide.js';
import { NEUTRAL_QUEUE_HEALTH, type OperationEffectiveness } from '../domain/health.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';
import { acceptTier3Proposal, type Tier3Request } from '../domain/tier3.js';

/**
 * The strategic tier against the model that actually serves it.
 *
 * The wiring under test is extended thinking on the remote route, which is a request field with
 * a token budget rather than a flag: a budget under the API's floor, a budget at or above
 * `max_tokens`, or any temperature but 1 beside it are all 400s, and the answer comes back as
 * reasoning blocks ahead of the JSON with the reasoning billed inside the output count. Every
 * one of those is a runtime fact a fake provider cannot prove.
 */

const KEY = (process.env.AION_ANTHROPIC_API_KEY ?? '').trim();
const ABSENT = KEY === '' || process.env.TEST_AION_GENERATION === 'local';

const CALL_TIMEOUT_MS = 120_000;

const CANDIDATES: readonly OperationCandidate[] = [
  { name: 'dead_letter', relevance: 0.62 },
  { name: 'memory_decay', relevance: 0.15 },
  { name: 'symbiosis_bridge', relevance: 0.15 },
];

function record(name: string, effectiveness: number): OperationEffectiveness {
  return {
    name,
    runs: 4,
    improved: Math.round(effectiveness * 4),
    failed: 0,
    effectiveness,
    cyclesSinceSelected: 6,
    lastRunAt: undefined,
    meanDurationMs: 900,
  };
}

/** A reading with one backlog that is plainly the largest thing in it. */
const REQUEST: Tier3Request = {
  health: healthFixture({
    queue: { ...NEUTRAL_QUEUE_HEALTH, depth: 74, exhausted: 61 },
    effectiveness: [record('dead_letter', 1), record('memory_decay', 1)],
  }),
  candidates: CANDIDATES,
  reason: 'no operation cleared the urgency threshold',
  insights: [
    '2026-09-13T02:00:00.000Z: memory_decay ran with its metric at 12 and did not move it: the next reading was 12',
  ],
};

function liveProvider(calls: ApiCall[]): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: KEY,
    model: process.env.AION_ANTHROPIC_MODEL ?? DEFAULTS.anthropic.model,
    thinkingBudgetTokens: DEFAULTS.anthropic.thinkingBudgetTokens,
    recordApiCall: (call) => calls.push(call),
  });
}

describe.skipIf(ABSENT)('the tier-3 advisor on the model that serves it', () => {
  it('answers a reading with a recommendation the gate accepts', async () => {
    const calls: ApiCall[] = [];

    const outcome = await adviseTier3(liveProvider(calls), REQUEST, {
      model: DEFAULTS.models.reflect,
      timeoutMs: CALL_TIMEOUT_MS,
    });

    console.log(`tier-3 live outcome: ${outcome.status}`);
    if (outcome.status === 'advised') {
      const { operation, confidence, rationale } = outcome.proposal;
      console.log(`  named ${operation} at ${String(confidence)}: ${rationale}`);
    }

    // Advised or declined are both answers. Failed and unusable are the call not arriving,
    // which is what the thinking configuration would break if it were sent wrong.
    expect(['advised', 'declined']).toContain(outcome.status);
    if (outcome.status === 'advised') {
      const acceptance = acceptTier3Proposal(
        outcome.proposal,
        CANDIDATES,
        REQUEST.health,
        DEFAULTS.maintenance.tier3AcceptanceFloor,
      );
      console.log(`  gate: ${acceptance.verdict}`);
      expect(acceptance.verdict).not.toBe('rejected');
    }
  }, 180_000);

  it('spends and accounts real thinking tokens on that call', async () => {
    const calls: ApiCall[] = [];

    await adviseTier3(liveProvider(calls), REQUEST, {
      model: DEFAULTS.models.reflect,
      timeoutMs: CALL_TIMEOUT_MS,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    console.log(
      `tier-3 live usage: ${String(call?.inputTokens)} in, ${String(call?.outputTokens)} out, ` +
        `${String(call?.thinkingTokens)} of the output was reasoning`,
    );

    expect(call?.usageError).toBeUndefined();
    expect(call?.thinkingTokens ?? 0).toBeGreaterThan(0);
    // Thinking is a share of the output bill, never an addition to it.
    expect(call?.thinkingTokens ?? 0).toBeLessThanOrEqual(call?.outputTokens ?? 0);
    expect(call?.surface).toBe('tier3_advisor');
  }, 180_000);
});
