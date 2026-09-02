import {
  adviseTier3,
  DEFAULT_TIER3_MODE,
  decide,
  DEFAULTS,
  introspectionOperations,
  ProviderRouter,
  resolveProviderRouting,
  reviewTier3Proposal,
  type Config,
  type OperationCandidate,
  type Provider,
  type Tier3Proposal,
  type Tier3Request,
} from '@aion/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  candidatesFor,
  NO_OPERATION,
  TIER3_SELECTION_BATTERY,
  type Tier3Case,
} from './tier3-advisor-selection.fixture.js';

/**
 * The shipped `AION_MAINTENANCE_TIER3_MODE`, measured rather than argued.
 *
 * The battery reads twenty-four cycles the deterministic tiers left idle and scores two
 * advisors over them. The first is one call: the model sees the reading, the candidate table,
 * and each operation's record, and names an operation or none. The second is that call plus the
 * review that argues the other side, which acts only when both agree, and is what the loop runs
 * in `act` mode.
 *
 * The rule was written before the numbers: two-pass agreement with the pre-committed answer at
 * or above 0.9, with no invalid selection anywhere in the corpus, ships `act`; anything less
 * ships `propose`. The last test asserts the shipped default still matches what this run
 * measures, in both directions, so an advisor that degrades below the bar fails the gate rather
 * than staying armed. A model is not deterministic, so a measurement that lands on the bar can
 * flap; that is the cost of a gate that measures rather than remembers.
 *
 * An invalid selection is a proposal the deterministic gates would throw away: an operation the
 * cycle never offered, or one whose own relevance says it has nothing to do. Zero of them is a
 * bar rather than a target, because a single one is the advisor recommending work that does not
 * exist.
 */

const CALL_TIMEOUT_MS = 120_000;

/** Both passes over twenty-four cases, at roughly a second or two per remote call. */
const BATTERY_DEADLINE_MS = 900_000;

/** The pre-registered bar. */
const AGREEMENT_BAR = 0.9;
const INVALID_BAR = 0;

type Scored = {
  readonly entry: Tier3Case;
  readonly candidates: readonly OperationCandidate[];
  /** What one call named, or `none`. */
  readonly single: string;
  /** What the call and its review together would run, or `none`. */
  readonly twoPass: string;
  readonly proposal: Tier3Proposal | undefined;
  readonly reviewed: string | undefined;
  /** Absent unless the advisor failed or answered unusably. */
  readonly unanswered: string | undefined;
  readonly invalid: boolean;
};

let config: Config;
let router: ProviderRouter;
let scored: Scored[] = [];

function batteryConfig(): Config {
  const apiKey = process.env.AION_ANTHROPIC_API_KEY ?? '';
  const local = process.env.TEST_AION_GENERATION === 'local';
  return {
    ...DEFAULTS,
    ollama: {
      ...DEFAULTS.ollama,
      url: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    },
    anthropic: { ...DEFAULTS.anthropic, apiKey },
    routing: { ...DEFAULTS.routing, reflect: local ? 'ollama' : DEFAULTS.routing.reflect },
    // structural_discovery's standing relevance rises with the orphan share, which takes the
    // orphan readings here at tier 2, and what this battery pins is the advisor rather than the
    // catalog's composition.
    maintenance: { ...DEFAULTS.maintenance, structuralDiscovery: false },
  };
}

/** The loop's own two calls, in the loop's own order: advise, then review what it advised. */
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
      single: NO_OPERATION,
      twoPass: NO_OPERATION,
      proposal: undefined,
      reviewed: undefined,
      unanswered: advice.status === 'declined' ? undefined : advice.status,
      invalid: false,
    };
  }

  const { proposal } = advice;
  const named = candidates.find((candidate) => candidate.name === proposal.operation);
  const review = await reviewTier3Proposal(provider, request, proposal, {
    model,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  // An unanswered review vetoes in the loop, so it vetoes in the measurement too.
  const upheld = review.status === 'upheld';
  return {
    entry,
    candidates,
    single: proposal.operation,
    twoPass: upheld ? proposal.operation : NO_OPERATION,
    proposal,
    reviewed: review.status,
    unanswered: undefined,
    invalid: named === undefined || named.relevance <= 0,
  };
}

function agreement(rows: readonly Scored[], said: (row: Scored) => string): number {
  const agreed = rows.filter((row) => said(row) === row.entry.expected).length;
  return rows.length === 0 ? 0 : agreed / rows.length;
}

beforeAll(async () => {
  config = batteryConfig();
  router = new ProviderRouter({ config });
  const provider = router.forRole('reflect');
  const { model } = router.routing.roles.reflect;

  const rows: Scored[] = [];
  for (const entry of TIER3_SELECTION_BATTERY) {
    rows.push(await consult(provider, model, entry, candidatesFor(entry.health, config)));
  }
  scored = rows;
}, BATTERY_DEADLINE_MS);

describe('the tier-3 advisor selection battery', () => {
  it('names the route it measured, so the number belongs to a model', () => {
    const route = router.routing.roles.reflect;
    const resolved = resolveProviderRouting(config).roles.reflect;

    console.log(
      `tier-3 battery route: provider ${route.provider}, model ${route.model}, ` +
        `reason ${route.reason}, local tag ${route.localModel}`,
    );

    expect(route).toEqual(resolved);
    expect(scored).toHaveLength(TIER3_SELECTION_BATTERY.length);
    const unanswered = scored.filter((row) => row.unanswered !== undefined);
    console.log(
      `advisor answered: ${String(scored.length - unanswered.length)}/${String(scored.length)}`,
    );
    for (const row of unanswered) {
      console.log(`  no answer on ${row.entry.key}: ${String(row.unanswered)}`);
    }
    expect(unanswered).toHaveLength(0);
  });

  /**
   * The drift guard on the fixtures. Every case has to be a cycle the deterministic tiers leave
   * to tier 3 under the shipped thresholds, and every candidate name has to come from the
   * shipped catalog. A relevance formula that moves therefore breaks this rather than quietly
   * turning the corpus into readings the advisor would never see.
   */
  it('holds twenty-four readings the deterministic tiers all leave to tier 3', () => {
    const catalog = new Set(introspectionOperations().map((operation) => operation.name));
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

  it('scores one call and two against the pre-committed answers', () => {
    const single = agreement(scored, (row) => row.single);
    const two = agreement(scored, (row) => row.twoPass);
    const invalid = scored.filter((row) => row.invalid);
    const vetoed = scored.filter((row) => row.reviewed !== undefined && row.reviewed !== 'upheld');

    console.log(
      `advisor alone: agreement ${single.toFixed(3)} ` +
        `(${String(scored.filter((row) => row.single === row.entry.expected).length)}/` +
        `${String(scored.length)})`,
    );
    console.log(
      `advisor and review: agreement ${two.toFixed(3)} ` +
        `(${String(scored.filter((row) => row.twoPass === row.entry.expected).length)}/` +
        `${String(scored.length)})`,
    );
    console.log(
      `second pass over ${String(scored.filter((row) => row.proposal !== undefined).length)} ` +
        `recommendation(s): ${String(vetoed.length)} vetoed, ` +
        `${String(invalid.length)} invalid selection(s)`,
    );
    for (const row of scored.filter((entry) => entry.twoPass !== entry.entry.expected)) {
      console.log(
        `  two-pass wrong on ${row.entry.key}: advised ${row.single}, ` +
          `review ${row.reviewed ?? 'not called'}, truth ${row.entry.expected} ` +
          `because ${row.entry.truthNote}`,
      );
    }
    for (const row of invalid) {
      console.log(`  invalid selection on ${row.entry.key}: ${row.single}`);
    }

    expect(scored).toHaveLength(TIER3_SELECTION_BATTERY.length);
  });

  /**
   * The pre-registered rule, asserted rather than described. It fails in both directions: an
   * advisor under the bar while the shipped default is `act` fails here, and so does one over
   * the bar while the default stays `propose`.
   */
  it('ships the default the measurement calls for', () => {
    const two = agreement(scored, (row) => row.twoPass);
    const invalid = scored.filter((row) => row.invalid).length;
    const meets = two >= AGREEMENT_BAR && invalid <= INVALID_BAR;
    const expected = meets ? 'act' : 'propose';

    console.log(
      `pre-registered rule: two-pass agreement ${two.toFixed(3)} against ` +
        `${String(AGREEMENT_BAR)} with ${String(invalid)} invalid selection(s) against ` +
        `${String(INVALID_BAR)}; the measurement calls for '${expected}' and the shipped ` +
        `default is '${DEFAULT_TIER3_MODE}'`,
    );

    expect(DEFAULT_TIER3_MODE).toBe(expected);
  });
});
