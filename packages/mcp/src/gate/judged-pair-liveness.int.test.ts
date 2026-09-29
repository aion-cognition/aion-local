import { findEpisodeFactNodes } from '@aion/core/infrastructure/graph/supersession-queries.js';
import { LIVE_SUPERSESSION_ROUTE_RESERVE } from '@aion/core/reflection/application/stages/supersession-judge.js';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { GateSubstrate, REMOTE_JUDGE_ABSENT } from './gate-substrate.fixture.js';

/**
 * A fresh pair reaching the judge, and the judge answering it.
 *
 * The subject is whether a real pair is decidable at all, not how well the judge decides: a claim
 * whose extraction nobody recorded names no source, a node nobody counted has no reading a judgment
 * can be fenced on, and a stage that meets either withholds the pair without asking anything. Two
 * episodes stating opposite things about the same subject are as ordinary as a pair gets, so if
 * this one is undecidable every pair is.
 *
 * The composition is the service's, seam included. A run whose stage reads evidence for itself
 * judges every pair it nominates and proves nothing about which ones the service would reach.
 */

const IDENTITY = 'judged-pair-liveness';

/**
 * The two episodes, stamped from an instant taken after the substrate opened. A fresh substrate
 * is born when it opens, and the birth fence refuses a push whose every turn reads before that,
 * so a fixed calendar date would stop reaching the judge on the day it fell behind the run.
 */
function episodes(at: Date): { readonly first: unknown; readonly second: unknown } {
  const after = (ms: number): string => new Date(at.getTime() + ms).toISOString();
  return {
    first: {
      summary: 'the payer sync job schedule, as settled',
      turns: [
        {
          role: 'user',
          text:
            'for the payer sync job we settled on running it nightly at 2am so the overnight batch ' +
            'has the full window. write that down as the decision.',
          occurred_at: after(0),
        },
        {
          role: 'assistant',
          text:
            'recorded: the payer sync job runs nightly at 2am. the overnight batch depends on the ' +
            'full window, so the schedule is nightly.',
          occurred_at: after(30_000),
        },
      ],
    },
    second: {
      summary: 'the payer sync job schedule, changed',
      turns: [
        {
          role: 'user',
          text:
            'change of plan on the payer sync job. it runs hourly now, not nightly at 2am. the ' +
            'nightly schedule is wrong and should not be followed.',
          occurred_at: after(300_000),
        },
        {
          role: 'assistant',
          text:
            'recorded: the payer sync job runs hourly. that replaces the nightly 2am schedule, ' +
            'which no longer holds.',
          occurred_at: after(330_000),
        },
      ],
    },
  };
}

const substrate = new GateSubstrate('judged-pair', { certifyJudgments: true });

beforeAll(async () => {
  await substrate.open();
}, 300_000);

afterAll(async () => {
  await substrate.close();
});

it.skipIf(REMOTE_JUDGE_ABSENT)(
  'a fresh contradicting pair reaches the judge and the judgment completes',
  async () => {
    const now = new Date();
    const { first: firstPush, second: secondPush } = episodes(now);
    const first = await substrate.store(firstPush, { identity: IDENTITY, now });
    const second = await substrate.store(secondPush, {
      identity: IDENTITY,
      now: new Date(now.getTime() + 60_000),
    });

    const orchestrator = substrate.orchestrator();
    await orchestrator.run(first.episode_id);
    const run = await orchestrator.run(second.episode_id);

    // The pair as the stage nominates it, asked of the seam the service gives the stage.
    const priorFacts = await findEpisodeFactNodes(substrate.driver, first.episode_id, now);
    const currentFacts = await findEpisodeFactNodes(substrate.driver, second.episode_id, now);
    const prior = priorFacts[0];
    const current = currentFacts[0];
    expect(prior).toBeDefined();
    expect(current).toBeDefined();
    if (prior === undefined || current === undefined) {
      return;
    }
    const seam = substrate.judgmentEvidence();
    if (seam === undefined) {
      throw new Error('the battery composes the judgment seam and got none');
    }
    const assembly = await seam.assemble({
      route: 'live_supersession',
      reservedUnits: LIVE_SUPERSESSION_ROUTE_RESERVE,
      use: 'claim_judgment',
      sides: [
        { nodeId: prior.id, statement: prior.text },
        { nodeId: current.id, statement: current.text },
      ],
    });
    // Named rather than compared as a status alone: an incomplete assembly carries the reason the
    // judge was not asked, and that reason is the thing this battery is about.
    expect({
      status: assembly.status,
      reasons: assembly.status === 'incomplete' ? assembly.reasons.map(reasonOf) : [],
    }).toEqual({ status: 'assembled', reasons: [] });
    if (assembly.status !== 'assembled') {
      return;
    }
    // Each side names the capture it came from. A side with no required source is a side the judge
    // would be shown a bare sentence for.
    for (const side of assembly.sides) {
      expect(side.evidence === 'whole_sources' ? side.requiredSources.length : 0).toBeGreaterThan(
        0,
      );
    }
    // The node's own state is bound, so a correction or a closure landing between the answer and
    // the write refuses the decision instead of confirming it.
    const scopes = assembly.revision.dependencies.map((entry) => entry.scope);
    expect(scopes).toContain('graph.node_state');

    // And the run itself: nothing withheld, and a judgment the model actually answered.
    const stage = run.summary.stages.find((entry) => entry.name === 'supersession');
    expect(run.summary.counts.supersessionWithheld ?? 0).toBe(0);
    expect(stage?.summary).toMatch(/^[1-9]\d* contradiction judgment\(s\)/);
  },
  600_000,
);

/** One reason, flattened to what a reader needs: which field, and why it blocked. */
function reasonOf(issue: { readonly field: string; readonly reason: string }): string {
  return `${issue.field}:${issue.reason}`;
}
