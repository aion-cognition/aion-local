import {
  DEFAULTS,
  judgeContradiction,
  ProviderRouter,
  resolveProviderRouting,
  reviewContradiction,
  type Config,
  type ContradictionJudgment,
  type Provider,
  type ReviewVerdict,
  type VetoCheck,
} from '@aion/core';
import { openCampaignProducer } from '@aion/core/infrastructure/providers/test-support/campaign-guard.js';
import type { CampaignProducerHandle } from '@aion/core/infrastructure/providers/test-support/campaign-guard.js';
import { testGenerationConfig } from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import {
  DEFAULT_SUPERSEDE_AUTO_CONFIDENCE,
  DEFAULT_SUPERSEDE_MODE,
} from '@aion/core/reflection/application/stages/supersession.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REMOTE_JUDGE_ABSENT } from './gate-substrate.fixture.js';
import {
  casesOfClass,
  PRECISION_BATTERY,
  type CaseClass,
  type PrecisionCase,
} from './supersession-precision.fixture.js';
import {
  agreesWithRuling,
  ruledRows,
  unscoredRows,
  type RetroRuling,
} from './supersession-retro.fixture.js';

/**
 * The shipped default's decision input, measured rather than argued.
 *
 * The battery scores two judges over the same 24 pairs. The single-pass judge is what the
 * service ran before: one call, one verdict, and a confidence that came back 0.95 on every
 * affirmative, so no threshold over it separates a right answer from a wrong one. The two-pass
 * judge sends each affirmative to a second call that argues the other side on the same
 * evidence, without seeing the first pass, and counts a closure only when both agree.
 *
 * The bars were written before the numbers: two-pass precision at or above 0.9 and recall at or
 * above 0.9. What changed in F is what the measurement is allowed to decide: it is reported
 * against those bars as an observation for the ruling packet, and the shipped default is pinned
 * to its own literal value rather than derived from this run. Measured agreement with a
 * preferred answer does not grant inference authority; a default change has to argue its own
 * case instead of riding on one battery run.
 *
 * The route is named in the output rather than assumed: with a key in the environment the
 * reflect role reaches the model the service runs on, and with none it reaches nothing.
 *
 * What this measures is the judge, on well-formed pairs. It is an upper bound on what the
 * stage can do: candidate generation hands the judge pairs that no ground truth covers, and
 * those only ever add false positives.
 */

const JUDGE_TIMEOUT_MS = 120_000;

/** Both passes over both sets, at roughly a second or two a call. */
const BATTERY_DEADLINE_MS = 900_000;

/** The pre-registered bar, on both halves. */
const PRECISION_BAR = 0.9;
const RECALL_BAR = 0.9;

type TwoPass = {
  readonly judgment: ContradictionJudgment | undefined;
  /** Absent when the first pass said no, since a negative gets no second call. */
  readonly review: ReviewVerdict | undefined;
};

type Scored = TwoPass & {
  readonly entry: PrecisionCase;
  /** The single-pass answer against the pre-committed truth. */
  readonly correct: boolean;
  /** The two-pass answer against the same truth. */
  readonly twoPassCorrect: boolean;
};

type ClassTally = {
  readonly caseClass: CaseClass;
  readonly n: number;
  readonly correct: number;
};

type Counts = {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly precision: number;
  readonly recall: number;
};

let config: Config;
let router: ProviderRouter;
let scored: Scored[] = [];
type RetroScore = {
  readonly key: string;
  readonly ruling: RetroRuling;
  readonly closed: boolean;
  /** Absent where the ruling is not a decision anyone made, so nothing can agree with it. */
  readonly agrees: boolean | undefined;
};

let retro: RetroScore[] = [];

function batteryConfig(): Config {
  return {
    ...DEFAULTS,
    ollama: {
      ...DEFAULTS.ollama,
      url: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    },
    ...testGenerationConfig(DEFAULTS),
  };
}

type Pair = {
  readonly subject: string;
  readonly priorLabel: string;
  readonly prior: string;
  readonly currentLabel: string;
  readonly current: string;
};

/**
 * The stage's own two calls, in the stage's own order: judge, then review the affirmative. A
 * battery that rebuilt either prompt would report a number for a judge the service does not run.
 */
async function judgeTwice(provider: Provider, model: string, pair: Pair): Promise<TwoPass> {
  const shared = {
    priorLabel: pair.priorLabel,
    currentLabel: pair.currentLabel,
    prior: pair.prior,
    current: pair.current,
    sharedSubject: pair.subject,
  };
  const first = await judgeContradiction(provider, shared, {
    model,
    timeoutMs: JUDGE_TIMEOUT_MS,
  });
  const judgment = first.status === 'judged' ? first.judgment : undefined;
  if (judgment?.contradicts !== true) {
    return { judgment, review: undefined };
  }
  const second = await reviewContradiction(provider, shared, {
    model,
    timeoutMs: JUDGE_TIMEOUT_MS,
  });
  // An unanswered review vetoes in the stage, so it vetoes in the measurement too.
  return {
    judgment,
    review:
      second.status === 'reviewed'
        ? second.verdict
        : {
            outcome: 'vetoed',
            check: 'unanswered',
            reason: `the second pass was ${second.status}`,
          },
  };
}

/** What the stage would do with the pair: close it only when both passes affirm. */
function closes(row: TwoPass): boolean {
  return row.judgment?.contradicts === true && row.review?.outcome === 'unanimous';
}

function ratio(numerator: number, denominator: number): string {
  return denominator === 0 ? 'n/a' : (numerator / denominator).toFixed(3);
}

function count(rows: readonly Scored[], said: (row: Scored) => boolean): Counts {
  const truePositives = rows.filter((row) => said(row) && row.entry.contradicts).length;
  const falsePositives = rows.filter((row) => said(row) && !row.entry.contradicts).length;
  const falseNegatives = rows.filter((row) => !said(row) && row.entry.contradicts).length;
  const trueNegatives = rows.filter((row) => !said(row) && !row.entry.contradicts).length;
  const claimed = truePositives + falsePositives;
  const actual = truePositives + falseNegatives;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision: claimed === 0 ? 0 : truePositives / claimed,
    recall: actual === 0 ? 0 : truePositives / actual,
  };
}

function report(label: string, counts: Counts): void {
  console.log(
    `${label}: TP ${String(counts.truePositives)}, FP ${String(counts.falsePositives)}, ` +
      `FN ${String(counts.falseNegatives)}, TN ${String(counts.trueNegatives)} | ` +
      `precision ${counts.precision.toFixed(3)}, recall ${counts.recall.toFixed(3)}`,
  );
}

function singlePass(row: Scored): boolean {
  return row.judgment?.contradicts === true;
}

function tallyClass(caseClass: CaseClass): ClassTally {
  const rows = scored.filter((row) => row.entry.caseClass === caseClass);
  return {
    caseClass,
    n: rows.length,
    correct: rows.filter((row) => row.twoPassCorrect).length,
  };
}

function vetoesByCheck(): Record<VetoCheck, number> {
  const totals: Record<VetoCheck, number> = { survival: 0, well_formedness: 0, unanswered: 0 };
  for (const row of scored) {
    if (row.review?.outcome === 'vetoed') {
      totals[row.review.check] += 1;
    }
  }
  return totals;
}

let producer: CampaignProducerHandle | undefined;

beforeAll(async () => {
  config = batteryConfig();
  // See the advisor battery: one producer opening per file carries the shared ledger's guard,
  // this process's condition, and the durable per-case usage record the matrix promises. The
  // retro rows below run through the same opening and are labelled as their own cases, so the
  // second-condition retro pass is legible as duplicate work rather than as named-case spend.
  const opened = openCampaignProducer({
    experiment: 'judge-comparison',
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
  for (const entry of PRECISION_BATTERY) {
    opened.beginCase(entry.key);
    const pass = await judgeTwice(provider, model, entry);
    rows.push({
      entry,
      ...pass,
      correct: pass.judgment?.contradicts === entry.contradicts,
      twoPassCorrect: closes(pass) === entry.contradicts,
    });
  }
  scored = rows;

  const retroRows: typeof retro = [];
  for (const row of [...ruledRows(), ...unscoredRows()]) {
    opened.beginCase(`retro:${row.key}`);
    const pass = await judgeTwice(provider, model, row);
    const closed = closes(pass);
    retroRows.push({
      key: row.key,
      ruling: row.ruling,
      closed,
      // Only a row someone actually decided can be agreed or disagreed with. A stale clear and
      // an open row are judged and printed, and scored by nothing.
      agrees:
        row.ruling === 'applied' || row.ruling === 'dismissed'
          ? agreesWithRuling(row.ruling, closed)
          : undefined,
    });
  }
  retro = retroRows;
}, BATTERY_DEADLINE_MS);

afterAll(() => {
  producer?.close();
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('the 24-case supersession battery', () => {
  it('names the route it measured, so the number belongs to a model', () => {
    const route = router.routing.roles.reflect;
    const resolved = resolveProviderRouting(config).roles.reflect;

    console.log(
      `supersession battery route: model ${route.model}, available ${String(route.available)}`,
    );

    expect(route).toEqual(resolved);
    expect(scored).toHaveLength(PRECISION_BATTERY.length);
    // An unusable answer scores as neither a hit nor a miss, so a run where the judge failed
    // would report a precision drawn from a handful of pairs without saying so.
    const answered = scored.filter((row) => row.judgment !== undefined).length;
    console.log(`judgments returned: ${String(answered)}/${String(scored.length)}`);
    expect(answered).toBe(scored.length);
  });

  it('scores both judges against the pre-committed truth', () => {
    const single = count(scored, singlePass);
    const two = count(scored, closes);

    report('single-pass', single);
    report('two-pass   ', two);
    const vetoes = vetoesByCheck();
    console.log(
      `second pass over ${String(scored.filter(singlePass).length)} affirmative judgment(s): ` +
        `${String(scored.filter((row) => row.review?.outcome === 'unanimous').length)} unanimous, ` +
        `vetoed ${String(vetoes.survival)} on survival, ` +
        `${String(vetoes.well_formedness)} on well-formedness, ` +
        `${String(vetoes.unanswered)} unanswered`,
    );
    // The third outcome class, named at zero rather than left out. The battery judges pairs
    // with no graph behind them, so no case here can have lost currency before the judgment;
    // saying so keeps this line the same shape as the stage's own counts and the retro set's,
    // where the class is not empty.
    console.log(
      `outcome classes: ${String(scored.filter(closes).length)} closed, ` +
        `${String(scored.length - scored.filter(closes).length)} proposed or vetoed, ` +
        '0 target-already-gone (the battery holds pairs, not graph state)',
    );
    for (const tally of (['true', 'bait', 'hard'] as const).map(tallyClass)) {
      console.log(
        `  class ${tally.caseClass}: ${String(tally.correct)}/${String(tally.n)} two-pass correct`,
      );
    }
    for (const row of scored.filter((entry) => !entry.twoPassCorrect)) {
      const verdict = row.review === undefined ? 'no second pass' : row.review.outcome;
      console.log(
        `  two-pass wrong on ${row.entry.key} (${row.entry.caseClass}): first pass said ` +
          `${String(row.judgment?.contradicts)}, second pass ${verdict}, ` +
          `truth ${String(row.entry.contradicts)} because ${row.entry.truthNote}`,
      );
    }

    expect(two.truePositives + two.falsePositives + two.falseNegatives + two.trueNegatives).toBe(
      scored.length,
    );
    // Every case is scoreable by construction, so a battery that scored fewer has a fixture
    // problem rather than a measurement.
    expect(casesOfClass('true')).toHaveLength(8);
    expect(casesOfClass('bait')).toHaveLength(8);
    expect(casesOfClass('hard')).toHaveLength(8);
  });

  /**
   * The reason the second pass exists rather than a threshold. Kept as a report rather than an
   * assertion: what it measures is a property of the model, and a run where confidence suddenly
   * discriminates is news, not a failure.
   */
  it('reports whether confidence separates a correct judgment from a wrong one', () => {
    const claimed = scored.filter(singlePass);
    const confidences = claimed
      .map((row) => row.judgment?.confidence ?? 0)
      .sort((left, right) => left - right);
    const rightOnes = claimed
      .filter((row) => row.correct)
      .map((row) => row.judgment?.confidence ?? 0);
    const wrongOnes = claimed
      .filter((row) => !row.correct)
      .map((row) => row.judgment?.confidence ?? 0);
    const distinct = [...new Set(confidences.map((value) => value.toFixed(2)))];
    const lowestRight = Math.min(...rightOnes, Number.POSITIVE_INFINITY);
    const highestWrong = Math.max(...wrongOnes, Number.NEGATIVE_INFINITY);
    const separable = rightOnes.length > 0 && wrongOnes.length > 0 && lowestRight > highestWrong;

    console.log(
      `confidence over ${String(claimed.length)} affirmative judgment(s): ` +
        `min ${confidences[0]?.toFixed(2) ?? 'n/a'}, ` +
        `max ${confidences[confidences.length - 1]?.toFixed(2) ?? 'n/a'}, ` +
        `distinct values [${distinct.join(', ')}], ` +
        `at or above the ${String(DEFAULT_SUPERSEDE_AUTO_CONFIDENCE)} gate ${String(
          confidences.filter((value) => value >= DEFAULT_SUPERSEDE_AUTO_CONFIDENCE).length,
        )}`,
    );
    console.log(
      `separation: lowest correct ${rightOnes.length === 0 ? 'n/a' : lowestRight.toFixed(2)}, ` +
        `highest wrong ${wrongOnes.length === 0 ? 'n/a' : highestWrong.toFixed(2)}, ` +
        `a threshold ${separable ? 'exists' : 'does not exist'}`,
    );

    expect(confidences.length).toBe(claimed.length);
  });

  /**
   * RETRO, and never folded into the figure above. Ground truth here is one person's ruling on
   * proposals the substrate raised about its own construction, read back after the fact, so an
   * agreement rate says the two judges would have decided alike and nothing about either being
   * right.
   */
  it('reports how often the two-pass judge agrees with the rulings a person already made', () => {
    const scoredRows = retro.filter((row) => row.agrees !== undefined);
    const agreed = scoredRows.filter((row) => row.agrees === true).length;
    const stale = retro.filter((row) => row.ruling === 'stale').length;
    const open = retro.filter((row) => row.ruling === 'open').length;

    console.log(
      `RETRO agreement with hand-decided rows: ${String(agreed)}/${String(scoredRows.length)} ` +
        `(${ratio(agreed, scoredRows.length)}); unscored: ${String(stale)} stale clear(s) ` +
        `where the target was already gone, ${String(open)} still open`,
    );
    for (const row of scoredRows.filter((entry) => entry.agrees === false)) {
      console.log(
        `  RETRO disagreed on ${row.key}: two-pass would ${row.closed ? 'close' : 'hold'}`,
      );
    }
    for (const row of retro.filter((entry) => entry.agrees === undefined)) {
      console.log(
        `  RETRO unscored ${row.key} (${row.ruling}): two-pass would ` +
          `${row.closed ? 'close' : 'hold'}, and nobody chose either way`,
      );
    }

    expect(scoredRows).toHaveLength(ruledRows().length);
    expect(retro.filter((row) => row.agrees === undefined)).toHaveLength(unscoredRows().length);
  });

  /**
   * The observation the ruling packet reads, no longer an authority gate. This battery used to
   * derive the shipped mode from its own run and assert the two agreed, which made measured
   * agreement with a preferred answer into inference authority; the F review ruled that out.
   * The measurement is printed with the bars beside it, and the shipped default is pinned to
   * its own literal value so a change to it still has to say why here, on its own terms.
   */
  it('reports the measurement against the bars and pins the shipped default', () => {
    const two = count(scored, closes);
    const meets = two.precision >= PRECISION_BAR && two.recall >= RECALL_BAR;

    console.log(
      `observation: two-pass precision ${two.precision.toFixed(3)} against ` +
        `${String(PRECISION_BAR)} and recall ${two.recall.toFixed(3)} against ` +
        `${String(RECALL_BAR)}; the bars are ${meets ? 'met' : 'not met'} on this run, and the ` +
        `shipped default stays '${DEFAULT_SUPERSEDE_MODE}' either way`,
    );

    expect(DEFAULT_SUPERSEDE_MODE).toBe('unanimous');
  });
});
