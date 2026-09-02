import { describe, expect, it } from 'vitest';

import {
  RELATED_PAIRS,
  UNRELATED_PAIRS,
  UNRELATED_SENTENCES,
  WEAK_RELATED_PAIRS,
  type ScoredPair,
} from './floors.fixtures.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { embedQueryPrefix } from '../../infrastructure/providers/embed-models.js';
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

/**
 * The committed calibration. It measures both distributions against the live embedding model
 * and fails when `recall.vectorAdmissionFloor` stops holding them apart, which is the only
 * signal that the constant has gone stale. A floor tuned on noise alone cannot tell "rejects
 * unrelated text" from "rejects everything".
 *
 * Measured 2026-09-02, snowflake-arctic-embed2 on host Ollama, and printed on every run:
 *   unrelated  n=43  p50 0.086  p95 0.267  max 0.299
 *   related    n=10  min 0.382  p05 0.438  p50 0.769
 *   weak       n=4   0.154 0.222 0.244 0.393   (related, under the floor, corroboration's job)
 *
 * The unrelated sample is 13 off-topic query/content pairs plus all 30 ordered cross pairs of
 * the six mutually unrelated sentences, which score far lower (p95 0.128) than the off-topic
 * pairs (p95 0.296) and pull the combined p95 down with them.
 *
 * The tails do not overlap on this model, which is what nomic-embed-text never gave: 0.083
 * separates the highest unrelated reading from the weakest genuine match. Phase 4.4 split that
 * gap into three and put both floors in it, 0.35 and 0.33, so every genuine match clears the
 * admission floor on the vector leg alone and every unrelated reading stays 0.031 under the
 * corroboration floor.
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

const EMBED_MODEL = process.env.AION_EMBED_MODEL ?? DEFAULTS.models.embed;

/**
 * The cue carries the model's query prefix and the content does not, because that is the
 * asymmetry `embedCues` sends at runtime. Measuring both sides raw would calibrate a floor
 * against a distribution recall never produces.
 */
const QUERY_PREFIX = embedQueryPrefix(EMBED_MODEL);

async function pairScores(pairs: readonly ScoredPair[]): Promise<number[]> {
  const flattened = pairs.flatMap((pair) => [`${QUERY_PREFIX}${pair.cue}`, pair.content]);
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

let unrelatedScores: readonly number[] = [];
let relatedScores: readonly number[] = [];
let unrelated: Distribution;

describe('the admission floor against this embedding model', () => {
  it('measures both distributions and reports them', async () => {
    // Each sentence stands in for a query on one side of the pair and for stored content on
    // the other, so both spellings are embedded and the cosine crosses them.
    const setScores = pairwiseCosines(
      await provider.embed(UNRELATED_SENTENCES.map((sentence) => `${QUERY_PREFIX}${sentence}`)),
      await provider.embed([...UNRELATED_SENTENCES]),
    );
    const offTopicScores = await pairScores(UNRELATED_PAIRS);
    const weakScores = await pairScores(WEAK_RELATED_PAIRS);

    relatedScores = await pairScores(RELATED_PAIRS);
    unrelatedScores = [...setScores, ...offTopicScores];
    unrelated = describeDistribution(unrelatedScores);

    console.log(
      [
        `model ${DEFAULTS.models.embed}, floor ${String(POLICY.vectorFloor)}, ` +
          `corroboration ${String(POLICY.corroborationFloor)}, bm25 ${POLICY.bm25Mode}`,
        line('unrelated (mutually unrelated sentences)', describeDistribution(setScores)),
        line('unrelated (off-topic query vs stored content)', describeDistribution(offTopicScores)),
        line('unrelated (all)', unrelated),
        line('related', describeDistribution(relatedScores)),
        line('weak related (under the floor by design)', describeDistribution(weakScores)),
        `related scores: ${relatedScores.map((score) => score.toFixed(3)).join(' ')}`,
        `weak related scores: ${weakScores.map((score) => score.toFixed(3)).join(' ')}`,
      ].join('\n'),
    );

    // Six sentences in two spellings are 30 ordered cross pairs, not the 15 unordered ones:
    // the cue side carries the query prefix, so cos(cue i, content j) is its own reading and
    // cos(cue j, content i) is another. The literal is pinned because the printed numbers
    // above are a sample of this size.
    expect(unrelated.count).toBe(UNRELATED_PAIRS.length + 30);
    expect(relatedScores).toHaveLength(RELATED_PAIRS.length);
  }, 120_000);

  it('holds them apart at the committed floor, or says what to re-measure', () => {
    const separation = checkSeparation({
      unrelatedScores,
      relatedScores,
      policy: POLICY,
      tolerance: CALIBRATION_TOLERANCE,
    });
    console.log(separation.detail);

    expect(separation.separated, separation.detail).toBe(true);
  });

  /**
   * Corroboration is a lower bar, not a suspended one. Two measurements that are both inside
   * the noise band are one distribution sampled twice; admitting on their agreement is the
   * same failure as a floor inside the band, and it is what every surviving off-topic item in
   * the gate turned out to be. The band it does open is real and narrow: between this floor
   * and the admission floor sits a genuine match no single cue phrased well enough.
   */
  it('leaves the corroboration floor above the noise and below the admission floor', () => {
    expect(POLICY.corroborationFloor).toBeGreaterThan(unrelated.p95);
    expect(POLICY.corroborationFloor).toBeLessThan(POLICY.vectorFloor);
  });

  /**
   * What the two floors together cost, stated rather than assumed. A genuine match under the
   * corroboration floor is reachable only by an exact lexical hit, so this number is the size
   * of the bet the floors are making and it belongs in the run's own output.
   */
  it('reports how many genuine matches only an exact hit can reach', () => {
    const lexicalOnly = relatedScores.filter((score) => score < POLICY.corroborationFloor);
    console.log(
      `genuine matches needing an exact lexical hit: ${String(lexicalOnly.length)}/` +
        `${String(relatedScores.length)} (${lexicalOnly.map((s) => s.toFixed(3)).join(' ')})`,
    );

    expect(lexicalOnly.length / relatedScores.length).toBeLessThanOrEqual(0.2);
  });
});
