import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import {
  CALIBRATION_TOLERANCE,
  describeDistribution,
  pairedCosines,
  type Distribution,
} from '../domain/floor-calibration.js';
import { ANSWERING_GOALS, RESTATING_GOALS, type FactsPair } from './facts.fixtures.js';

/**
 * The committed calibration behind `recall.restatementFloor`, in the shape
 * `floor-calibration.int.test.ts` established: measure both distributions against the live
 * embedding model, and fail when the constant stops separating them.
 *
 * Both distributions are Goal and Plan text scored against the query that retrieves it. One is
 * a node that says the question back and answers nothing, which a measured run served at facts
 * rank 1; the other is a node that answers. A floor fitted to the first alone would swallow
 * every Goal a user legitimately asked about, the same one-sided mistake the admission floors
 * had to avoid.
 *
 * Measured 2026-08-29, nomic-embed-text on host Ollama, printed on every run:
 *   restating  n=8  min 0.841  p05 0.854  p50 0.909  p95 0.951  max 0.960
 *   answering  n=8  min 0.416  p05 0.428  p50 0.552  p95 0.714  max 0.729
 * Committed floor 0.80 sits in that gap: 8 of 8 restatements caught, 0 of 8 answers touched.
 */

const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const FLOOR = DEFAULTS.recall.restatementFloor;

const provider = new OllamaProvider({
  baseUrl: OLLAMA_URL,
  embedModel: process.env.AION_EMBED_MODEL ?? DEFAULTS.models.embed,
});

async function pairScores(pairs: readonly FactsPair[]): Promise<number[]> {
  const flattened = pairs.flatMap((pair) => [pair.query, pair.content]);
  return pairedCosines(await provider.embed(flattened));
}

function line(label: string, distribution: Distribution): string {
  return (
    `${label}: n=${String(distribution.count)} ` +
    `min ${distribution.min.toFixed(3)} p05 ${distribution.p05.toFixed(3)} ` +
    `p50 ${distribution.p50.toFixed(3)} p95 ${distribution.p95.toFixed(3)} ` +
    `max ${distribution.max.toFixed(3)}`
  );
}

describe('the restatement floor against the live embedding model', () => {
  it('separates a Goal that restates the query from one that answers it', async () => {
    const restating = describeDistribution(await pairScores(RESTATING_GOALS));
    const answering = describeDistribution(await pairScores(ANSWERING_GOALS));

    console.log(`restatement floor ${FLOOR.toFixed(2)}`);
    console.log(line('restating', restating));
    console.log(line('answering', answering));

    // At the extremes, not at a percentile: the set is eight pairs a side and the whole claim
    // is that no answering Goal reaches the floor while every restating one clears it.
    expect(answering.max).toBeLessThan(restating.min);
    expect(restating.min).toBeGreaterThanOrEqual(FLOOR - CALIBRATION_TOLERANCE);
    expect(answering.max).toBeLessThanOrEqual(FLOOR + CALIBRATION_TOLERANCE);
  }, 120_000);

  it('catches every restatement and touches no answer at the committed floor', async () => {
    const restating = await pairScores(RESTATING_GOALS);
    const answering = await pairScores(ANSWERING_GOALS);

    const caught = restating.filter((score) => score >= FLOOR).length;
    const misfired = answering.filter((score) => score >= FLOOR).length;
    console.log(
      `at floor ${FLOOR.toFixed(2)}: caught ${String(caught)}/${String(restating.length)}, ` +
        `misfired ${String(misfired)}/${String(answering.length)}`,
    );

    expect(caught).toBe(restating.length);
    expect(misfired).toBe(0);
  }, 120_000);
});
