import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  judgeContradiction,
  ProviderRouter,
  resolveProviderRouting,
  type Config,
  type ContradictionJudgment,
} from '@aion/core';
import {
  DEFAULT_SUPERSEDE_AUTO_CONFIDENCE,
  DEFAULT_SUPERSEDE_MODE,
} from '@aion/core/reflection/application/stages/supersession.js';
import {
  casesOfClass,
  PRECISION_BATTERY,
  type CaseClass,
  type PrecisionCase,
} from './supersession-precision.fixture.js';

/**
 * The auto-mode decision input, re-measured. Auto-apply returns only at 0.9 precision on this
 * battery, and only if confidence separates a correct judgment from a wrong one: a judge that
 * answers 1.0 to everything makes any threshold either a pass-through or a wall, which is what
 * the local model did over 16 live proposals.
 *
 * The route is named in the output rather than assumed. With a key in the environment the
 * reflect role routes to Anthropic, which is the route the service runs on; setting
 * `TEST_AION_GENERATION=local` pins the role to Ollama here so the same 24 pairs can be read
 * against the local model for the comparison.
 *
 * What this measures is the judge, on well-formed pairs. It is an upper bound on what the
 * stage can do: candidate generation hands the judge pairs that no ground truth covers, and
 * those only ever add false positives.
 */

const JUDGE_TIMEOUT_MS = 120_000;

/** The whole battery in one file, at roughly a second or two per remote judgment. */
const BATTERY_DEADLINE_MS = 900_000;

type Scored = {
  readonly entry: PrecisionCase;
  readonly judgment: ContradictionJudgment | undefined;
  readonly correct: boolean;
};

type ClassTally = {
  readonly caseClass: CaseClass;
  readonly n: number;
  readonly correct: number;
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
  };
}

function positives(rows: readonly Scored[]): readonly Scored[] {
  return rows.filter((row) => row.judgment?.contradicts === true);
}

function ratio(numerator: number, denominator: number): string {
  return denominator === 0 ? 'n/a' : (numerator / denominator).toFixed(3);
}

function tallyClass(caseClass: CaseClass): ClassTally {
  const rows = scored.filter((row) => row.entry.caseClass === caseClass);
  return {
    caseClass,
    n: rows.length,
    correct: rows.filter((row) => row.correct).length,
  };
}

beforeAll(async () => {
  config = batteryConfig();
  router = new ProviderRouter({ config });
  const provider = router.forRole('reflect');
  const route = router.routing.roles.reflect;

  const rows: Scored[] = [];
  for (const entry of PRECISION_BATTERY) {
    const outcome = await judgeContradiction(
      provider,
      {
        priorLabel: entry.priorLabel,
        currentLabel: entry.currentLabel,
        prior: entry.prior,
        current: entry.current,
        sharedSubject: entry.subject,
      },
      { model: route.model, timeoutMs: JUDGE_TIMEOUT_MS },
    );
    const judgment = outcome.status === 'judged' ? outcome.judgment : undefined;
    rows.push({
      entry,
      judgment,
      correct: judgment !== undefined && judgment.contradicts === entry.contradicts,
    });
  }
  scored = rows;
}, BATTERY_DEADLINE_MS);

describe('the 24-case supersession battery', () => {
  it('names the route it measured, so the number belongs to a model', () => {
    const route = router.routing.roles.reflect;
    const resolved = resolveProviderRouting(config).roles.reflect;

    console.log(
      `supersession battery route: provider ${route.provider}, model ${route.model}, ` +
        `reason ${route.reason}, local tag ${route.localModel}`,
    );

    expect(route).toEqual(resolved);
    expect(scored).toHaveLength(PRECISION_BATTERY.length);
    // An unusable answer scores as neither a hit nor a miss, so a run where the judge failed
    // would report a precision drawn from a handful of pairs without saying so.
    const answered = scored.filter((row) => row.judgment !== undefined).length;
    console.log(`judgments returned: ${String(answered)}/${String(scored.length)}`);
    expect(answered).toBe(scored.length);
  });

  it('scores precision and recall against the pre-committed truth', () => {
    const truePositives = positives(scored).filter((row) => row.entry.contradicts).length;
    const falsePositives = positives(scored).filter((row) => !row.entry.contradicts).length;
    const falseNegatives = scored.filter(
      (row) => row.entry.contradicts && row.judgment?.contradicts !== true,
    ).length;
    const trueNegatives = scored.filter(
      (row) => !row.entry.contradicts && row.judgment?.contradicts === false,
    ).length;

    const precision = ratio(truePositives, truePositives + falsePositives);
    const recall = ratio(truePositives, truePositives + falseNegatives);

    console.log(
      `supersession precision: TP ${String(truePositives)}, FP ${String(falsePositives)}, ` +
        `FN ${String(falseNegatives)}, TN ${String(trueNegatives)} | ` +
        `precision ${precision}, recall ${recall}`,
    );
    for (const tally of (['true', 'bait', 'hard'] as const).map(tallyClass)) {
      console.log(
        `  class ${tally.caseClass}: ${String(tally.correct)}/${String(tally.n)} answered correctly`,
      );
    }
    for (const row of scored.filter((entry) => !entry.correct)) {
      console.log(
        `  wrong on ${row.entry.key} (${row.entry.caseClass}): said ` +
          `${String(row.judgment?.contradicts)} at ${row.judgment?.confidence.toFixed(2) ?? 'n/a'}, ` +
          `truth ${String(row.entry.contradicts)} because ${row.entry.truthNote}`,
      );
    }

    expect(truePositives + falsePositives + falseNegatives + trueNegatives).toBe(scored.length);
    // Every case is scoreable by construction, so a battery that scored fewer has a fixture
    // problem rather than a measurement.
    expect(casesOfClass('true')).toHaveLength(8);
    expect(casesOfClass('bait')).toHaveLength(8);
    expect(casesOfClass('hard')).toHaveLength(8);
  });

  it('reports whether confidence separates a correct judgment from a wrong one', () => {
    const claimed = positives(scored);
    const confidences = claimed
      .map((row) => row.judgment?.confidence ?? 0)
      .sort((left, right) => left - right);
    const rightOnes = claimed.filter((row) => row.correct).map((row) => row.judgment?.confidence ?? 0);
    const wrongOnes = claimed.filter((row) => !row.correct).map((row) => row.judgment?.confidence ?? 0);
    const distinct = [...new Set(confidences.map((value) => value.toFixed(2)))];
    const lowestRight = Math.min(...rightOnes, Number.POSITIVE_INFINITY);
    const highestWrong = Math.max(...wrongOnes, Number.NEGATIVE_INFINITY);
    const separable = rightOnes.length > 0 && wrongOnes.length > 0 && lowestRight > highestWrong;

    console.log(
      `confidence over ${String(claimed.length)} affirmative judgment(s): ` +
        `min ${confidences[0]?.toFixed(2) ?? 'n/a'}, ` +
        `max ${confidences[confidences.length - 1]?.toFixed(2) ?? 'n/a'}, ` +
        `distinct values [${distinct.join(', ')}], ` +
        `at or above the ${String(DEFAULT_SUPERSEDE_AUTO_CONFIDENCE)} gate ` +
        `${String(confidences.filter((value) => value >= DEFAULT_SUPERSEDE_AUTO_CONFIDENCE).length)}`,
    );
    console.log(
      `separation: lowest correct ${rightOnes.length === 0 ? 'n/a' : lowestRight.toFixed(2)}, ` +
        `highest wrong ${wrongOnes.length === 0 ? 'n/a' : highestWrong.toFixed(2)}, ` +
        `a threshold ${separable ? 'exists' : 'does not exist'}`,
    );

    expect(confidences.length).toBe(claimed.length);
  });

  it('keeps auto-apply closed until both halves of the rule are met', () => {
    const truePositives = positives(scored).filter((row) => row.entry.contradicts).length;
    const falsePositives = positives(scored).filter((row) => !row.entry.contradicts).length;
    const denominator = truePositives + falsePositives;
    const precision = denominator === 0 ? 0 : truePositives / denominator;
    const claimed = positives(scored);
    const lowestRight = Math.min(...claimed.filter((row) => row.correct).map((row) => row.judgment?.confidence ?? 0));
    const highestWrong = Math.max(...claimed.filter((row) => !row.correct).map((row) => row.judgment?.confidence ?? 0));
    const separable = Number.isFinite(lowestRight) && Number.isFinite(highestWrong) && lowestRight > highestWrong;

    console.log(
      `auto-mode rule: precision ${precision.toFixed(3)} against the 0.9 bar, ` +
        `confidence ${separable ? 'discriminates' : 'does not discriminate'}; ` +
        `shipped default stays '${DEFAULT_SUPERSEDE_MODE}'`,
    );

    // The pin, asserted rather than described: the shipped default only moves when a measured
    // precision at or above 0.9 arrives together with a confidence distribution a threshold
    // can cut. Either half missing leaves every judgment a row a person decides on.
    if (precision < 0.9 || (!separable && falsePositives > 0)) {
      expect(DEFAULT_SUPERSEDE_MODE).toBe('propose');
    }
  });
});
