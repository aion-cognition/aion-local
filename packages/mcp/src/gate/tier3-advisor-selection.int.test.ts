import {
  acceptTier3Proposal,
  adviseTier3,
  DEFAULT_TIER3_MODE,
  decide,
  DEFAULTS,
  introspectionOperations,
  ProviderRouter,
  resolveProviderRouting,
  type Config,
  type OperationCandidate,
  type Provider,
  type Tier3Proposal,
  type Tier3Request,
} from '@aion/core';
import { openCampaignProducer } from '@aion/core/infrastructure/providers/test-support/campaign-guard.js';
import type { CampaignProducerHandle } from '@aion/core/infrastructure/providers/test-support/campaign-guard.js';
import { testGenerationConfig } from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REMOTE_JUDGE_ABSENT } from './gate-substrate.fixture.js';
import {
  candidatesFor,
  NO_OPERATION,
  TIER3_SELECTION_BATTERY,
  type Tier3Case,
} from './tier3-advisor-selection.fixture.js';

/**
 * What the tier-3 advisor does with twenty-four readings the deterministic tiers leave idle.
 *
 * This battery no longer sets `AION_MAINTENANCE_TIER3_MODE`. It used to: the rule was
 * two-pass agreement at or above 0.9 ships `act`, and the second pass it scored vetoed 20 of 23
 * recommendations including ones this corpus calls correct, so the knob shipped `propose` and
 * the strategic tier paid for a call every idle tick and threw the answer away. Agreement with a
 * pre-committed answer over fixed readings is not what a live loop learns from either: two
 * defensible operations can both address one reading, and the corpus can only name one of them.
 *
 * What replaced it is the loop's own record. Every model-chosen run is scored on the metric its
 * operation declared, and that score weights the next recommendation for the same operation
 * through the acceptance blend. So this file measures rather than gates: it prints agreement,
 * prints how many recommendations the live acceptance gate would act on, and asserts two bars
 * that are about the advisor being usable at all rather than about it being right.
 *
 * An invalid selection is a proposal the deterministic gates throw away: an operation the cycle
 * never offered, or one whose own relevance says it has nothing to do. Zero of them stays a bar
 * rather than a target, because a single one is the advisor recommending work that does not
 * exist.
 */

const CALL_TIMEOUT_MS = 120_000;

/** One pass over twenty-four cases, at a few seconds a remote call now that it reasons. */
const BATTERY_DEADLINE_MS = 900_000;

/** The pre-registered bars: the advisor answers, and never names work that is not there. */
const INVALID_BAR = 0;
const UNANSWERED_BAR = 0;

type Scored = {
  readonly entry: Tier3Case;
  readonly candidates: readonly OperationCandidate[];
  /** What the call named, or `none`. */
  readonly named: string;
  readonly proposal: Tier3Proposal | undefined;
  /** Absent unless the advisor failed or answered unusably. */
  readonly unanswered: string | undefined;
  readonly invalid: boolean;
  /** What the live acceptance gate did with the recommendation, on this case's own record. */
  readonly gate: string | undefined;
};

let config: Config;
let router: ProviderRouter;
let scored: Scored[] = [];

function batteryConfig(): Config {
  return {
    ...DEFAULTS,
    ollama: {
      ...DEFAULTS.ollama,
      url: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    },
    ...testGenerationConfig(DEFAULTS),
    // structural_discovery's standing relevance rises with the orphan share, which takes the
    // orphan readings here at tier 2, and what this battery pins is the advisor rather than the
    // catalog's composition.
    maintenance: { ...DEFAULTS.maintenance, structuralDiscovery: false },
  };
}

/** The loop's own call, and the loop's own gate over what it answered. */
async function consult(
  provider: Provider,
  model: string,
  entry: Tier3Case,
  candidates: readonly OperationCandidate[],
): Promise<Scored> {
  const request: Tier3Request = {
    health: entry.health,
    candidates,
    reason: 'no operation cleared the urgency threshold',
  };
  const advice = await adviseTier3(provider, request, { model, timeoutMs: CALL_TIMEOUT_MS });
  if (advice.status !== 'advised') {
    return {
      entry,
      candidates,
      named: NO_OPERATION,
      proposal: undefined,
      unanswered: advice.status === 'declined' ? undefined : advice.status,
      invalid: false,
      gate: undefined,
    };
  }

  const { proposal } = advice;
  const named = candidates.find((candidate) => candidate.name === proposal.operation);
  const acceptance = acceptTier3Proposal(
    proposal,
    candidates,
    entry.health,
    DEFAULTS.maintenance.tier3AcceptanceFloor,
  );
  return {
    entry,
    candidates,
    named: proposal.operation,
    proposal,
    unanswered: undefined,
    invalid: named === undefined || named.relevance <= 0,
    gate: acceptance.verdict,
  };
}

function agreement(rows: readonly Scored[]): number {
  const agreed = rows.filter((row) => row.named === row.entry.expected).length;
  return rows.length === 0 ? 0 : agreed / rows.length;
}

let producer: CampaignProducerHandle | undefined;

beforeAll(async () => {
  config = batteryConfig();
  // One producer opening for the whole file: the campaign ledger's guard (carrying whatever
  // lifetime budget the coordinator wrote onto that file), the condition this process runs, and
  // the durable per-case usage recorder. `recordApiCall` is what puts each billed response on
  // the books under its own case; the reservation the guard takes is the bound, not the record.
  const opened = openCampaignProducer({
    experiment: 'advisor',
    ceilingUsd: config.anthropic.dailyCeilingUsd,
  });
  producer = opened;
  router = new ProviderRouter({
    config,
    spending: opened.guard,
    recordApiCall: opened.recordApiCall,
    ...(opened.frameOverride === undefined ? {} : { frameOverride: opened.frameOverride }),
  });
  const provider = router.forRole('reflect');
  const { model } = router.routing.roles.reflect;

  const rows: Scored[] = [];
  for (const entry of TIER3_SELECTION_BATTERY) {
    opened.beginCase(entry.key);
    rows.push(await consult(provider, model, entry, candidatesFor(entry.health, config)));
  }
  scored = rows;
}, BATTERY_DEADLINE_MS);

afterAll(() => {
  producer?.close();
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('the tier-3 advisor selection battery', () => {
  it('names the route it measured, so the number belongs to a model', () => {
    const route = router.routing.roles.reflect;
    const resolved = resolveProviderRouting(config).roles.reflect;

    console.log(`tier-3 battery route: model ${route.model}, available ${String(route.available)}`);

    expect(route).toEqual(resolved);
    expect(scored).toHaveLength(TIER3_SELECTION_BATTERY.length);
    const unanswered = scored.filter((row) => row.unanswered !== undefined);
    console.log(
      `advisor answered: ${String(scored.length - unanswered.length)}/${String(scored.length)}`,
    );
    for (const row of unanswered) {
      console.log(`  no answer on ${row.entry.key}: ${String(row.unanswered)}`);
    }
    expect(unanswered.length).toBeLessThanOrEqual(UNANSWERED_BAR);
  });

  /**
   * The drift guard on the fixtures. Every case has to be a cycle the deterministic tiers leave
   * to tier 3 under the shipped thresholds, and every candidate name has to come from the
   * shipped catalog. A relevance formula that moves therefore breaks this rather than quietly
   * turning the corpus into readings the advisor would never see.
   */
  it('holds twenty-four readings the deterministic tiers all leave to tier 3', () => {
    const catalog = new Set(introspectionOperations(config).map((operation) => operation.name));
    expect(TIER3_SELECTION_BATTERY.length).toBeGreaterThanOrEqual(20);

    for (const entry of TIER3_SELECTION_BATTERY) {
      const candidates = candidatesFor(entry.health, config);
      for (const candidate of candidates) {
        expect(catalog.has(candidate.name)).toBe(true);
      }
      const decision = decide({
        health: entry.health,
        candidates,
        starvationCycles: DEFAULTS.maintenance.starvationCycles,
        urgencyThreshold: DEFAULTS.maintenance.urgencyThreshold,
        effectivenessFloor: DEFAULTS.maintenance.effectivenessFloor,
        cost: {
          referenceMs: DEFAULTS.maintenance.costReferenceMs,
          decades: DEFAULTS.maintenance.costDecades,
          maxDivisor: DEFAULTS.maintenance.maxCostDivisor,
        },
        tier3Enabled: true,
      });
      expect({ key: entry.key, kind: decision.kind }).toEqual({ key: entry.key, kind: 'tier3' });
      if (entry.expected !== NO_OPERATION) {
        expect(catalog.has(entry.expected)).toBe(true);
      }
    }
  });

  it('never recommends work the reading does not carry', () => {
    const invalid = scored.filter((row) => row.invalid);
    for (const row of invalid) {
      console.log(`  invalid selection on ${row.entry.key}: ${row.named}`);
    }

    expect(invalid.length).toBeLessThanOrEqual(INVALID_BAR);
  });

  /**
   * The observation, printed and asserted on nothing. Agreement with the corpus says how often
   * the advisor picked the operation a person named from the same numbers; it is a reading of
   * this model on these fixtures, not a permission bar.
   */
  it('reports what the advisor named and what the gate did with it', () => {
    const agreed = agreement(scored);
    const accepted = scored.filter((row) => row.gate === 'accepted');
    const downgraded = scored.filter((row) => row.gate === 'downgraded');

    console.log(
      `advisor agreement with the corpus: ${agreed.toFixed(3)} ` +
        `(${String(scored.filter((row) => row.named === row.entry.expected).length)}/` +
        `${String(scored.length)})`,
    );
    console.log(
      `acceptance gate over ${String(scored.filter((row) => row.proposal !== undefined).length)} ` +
        `recommendation(s): ${String(accepted.length)} accepted, ` +
        `${String(downgraded.length)} downgraded on the effectiveness blend`,
    );
    for (const row of scored.filter((entry) => entry.named !== entry.entry.expected)) {
      console.log(
        `  differed on ${row.entry.key}: advised ${row.named}, corpus says ` +
          `${row.entry.expected} because ${row.entry.truthNote}`,
      );
    }

    expect(scored).toHaveLength(TIER3_SELECTION_BATTERY.length);
  });

  /**
   * The knob this file used to set. It is pinned here rather than derived, and the comment on
   * `tier3Mode` carries the reasoning: what guards a model-chosen run is that the run is scored
   * and the score weights the next recommendation, which no battery over fixed readings
   * measures. This assertion fails if someone flips the default back without saying why.
   */
  it('ships act', () => {
    expect(DEFAULT_TIER3_MODE).toBe('act');
  });
});
