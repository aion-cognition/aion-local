import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import type { AdmissionPolicy } from '../domain/admission.js';
import {
  CALIBRATION_TOLERANCE,
  checkSeparation,
  describeDistribution,
  pairedCosines,
  pairwiseCosines,
  type Distribution,
} from '../domain/floor-calibration.js';
import {
  RELATED_PAIRS,
  UNRELATED_PAIRS,
  UNRELATED_SENTENCES,
  WEAK_RELATED_PAIRS,
  type ScoredPair,
} from './floors.fixtures.js';

/**
 * The committed calibration. It measures both distributions against the live embedding model
 * and fails when `recall.vectorAdmissionFloor` stops separating them, which is the only signal
 * that the constant has gone stale — a floor tuned on noise alone cannot tell "rejects
 * unrelated text" from "rejects everything" (EX-1, and the consultation's amnesia warning
 * about the genuine pair measured at 0.631).
 *
 * Measured 2026-08-28, nomic-embed-text on host Ollama, and printed on every run:
 *   unrelated  n=23  p50 0.391  p95 0.474  max 0.536
 *   related    n=10  min 0.451  p05 0.513  p50 0.773
 *   weak       n=4   0.355 0.390 0.458 0.522   (related, under the floor, corroboration's job)
 * Committed floor 0.50 sits in the gap; 0.60 would have starved the 0.588 pair.
 */

const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const provider = new OllamaProvider({
  baseUrl: OLLAMA_URL,
  embedModel: process.env.AION_EMBED_MODEL ?? DEFAULTS.models.embed,
});

const POLICY: AdmissionPolicy = {
  vectorFloor: DEFAULTS.recall.vectorAdmissionFloor,
  corroborationFloor: DEFAULTS.recall.corroborationFloor,
  bm25Mode: DEFAULTS.recall.bm25AdmissionMode,
};

async function pairScores(pairs: readonly ScoredPair[]): Promise<number[]> {
  const flattened = pairs.flatMap((pair) => [pair.cue, pair.content]);
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

let unrelated: Distribution;
let related: Distribution;

describe('the admission floor against this embedding model', () => {
  it('measures both distributions and reports them', async () => {
    const setScores = pairwiseCosines(await provider.embed([...UNRELATED_SENTENCES]));
    const offTopicScores = await pairScores(UNRELATED_PAIRS);
    const relatedScores = await pairScores(RELATED_PAIRS);
    const weakScores = await pairScores(WEAK_RELATED_PAIRS);

    unrelated = describeDistribution([...setScores, ...offTopicScores]);
    related = describeDistribution(relatedScores);

    console.log(
      [
        `model ${DEFAULTS.models.embed}, floor ${String(POLICY.vectorFloor)}, ` +
          `corroboration ${String(POLICY.corroborationFloor)}, bm25 ${POLICY.bm25Mode}`,
        line('unrelated (mutually unrelated sentences)', describeDistribution(setScores)),
        line('unrelated (off-topic query vs stored content)', describeDistribution(offTopicScores)),
        line('unrelated (all)', unrelated),
        line('related', related),
        line('weak related (under the floor by design)', describeDistribution(weakScores)),
        `weak related scores: ${weakScores.map((score) => score.toFixed(3)).join(' ')}`,
      ].join('\n'),
    );

    expect(unrelated.count).toBe(UNRELATED_PAIRS.length + 15);
    expect(related.count).toBe(RELATED_PAIRS.length);
  }, 120_000);

  it('separates them at the committed floor, or says what to re-measure', () => {
    const separation = checkSeparation({
      unrelated,
      related,
      policy: POLICY,
      tolerance: CALIBRATION_TOLERANCE,
    });

    expect(separation.separated, separation.detail).toBe(true);
  });

  it('leaves the corroboration floor above the noise median and below the admission floor', () => {
    expect(POLICY.corroborationFloor).toBeGreaterThan(unrelated.p50);
    expect(POLICY.corroborationFloor).toBeLessThan(POLICY.vectorFloor);
  });
});
