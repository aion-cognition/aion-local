import { describe, expect, it } from 'vitest';

import { maxEmbedInputChars } from './embed-models.js';
import { OllamaProvider } from './ollama-provider.js';
import type { Vector } from './types.js';
import { DEFAULTS } from '../config/defaults.js';

/**
 * The one property every embedding-driven decision rests on: two different names must embed
 * differently. Ollama's `nomic-embed-text` collapses any word carrying an uppercase letter
 * onto a single out-of-vocabulary token, so without the provider's case fold this file's
 * first assertion returns a cosine of exactly 1.0 for two unrelated proper nouns, and the
 * name-vector nominator, whose threshold is a cosine over name embeddings, hands the cascade
 * every entity in the graph.
 *
 * Structural, not semantic: nothing here asserts what the model thinks two names mean, only
 * that it distinguishes them at all.
 */

const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

/**
 * What the nominator compares. `vector.similarity.cosine` rescales onto [0,1] and the query
 * converts it back with `asCosine`, so the number `entityDedupThreshold` is read against is a
 * true cosine and this is the same reading taken here. It used to apply that conversion to a
 * cosine that was already true, which halves the reading: the near-duplicate below measures
 * 0.862 and reached the assertion as 0.724.
 */
function dedupScore(left: Vector, right: Vector): number {
  return cosine(left, right);
}

function cosine(left: Vector, right: Vector): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

const provider = new OllamaProvider({
  baseUrl: OLLAMA_URL,
  embedModel: DEFAULTS.models.embed,
});

describe('OllamaProvider.embed against the live embed model', () => {
  it('separates two unrelated proper nouns well below the entity-dedup threshold', async () => {
    const [redis, postgres, person, otherPerson] = await provider.embed([
      'Redis',
      'Postgres',
      'Thandiwe Baptiste',
      'Marguerite Okonkwo',
    ]);
    expect(redis).toBeDefined();
    expect(postgres).toBeDefined();
    expect(person).toBeDefined();
    expect(otherPerson).toBeDefined();

    expect(redis).not.toEqual(postgres);
    expect(person).not.toEqual(otherPerson);
    console.log(
      `unrelated names against the ${String(DEFAULTS.reflection.entityDedupThreshold)} ` +
        `nomination floor: redis/postgres ${dedupScore(redis!, postgres!).toFixed(3)}, ` +
        `two personal names ${dedupScore(person!, otherPerson!).toFixed(3)}`,
    );
    expect(dedupScore(redis!, postgres!)).toBeLessThan(DEFAULTS.reflection.entityDedupThreshold);
    expect(dedupScore(person!, otherPerson!)).toBeLessThan(
      DEFAULTS.reflection.entityDedupThreshold,
    );
  }, 60_000);

  it('still clears the threshold for a genuine near-duplicate name', async () => {
    const [plural, singular] = await provider.embed(['numeric ids', 'numeric id']);
    console.log(`near-duplicate name: ${dedupScore(plural!, singular!).toFixed(3)}`);
    expect(plural).toBeDefined();
    expect(singular).toBeDefined();
    expect(dedupScore(plural!, singular!)).toBeGreaterThanOrEqual(
      DEFAULTS.reflection.entityDedupThreshold,
    );
  }, 60_000);
});

/**
 * A long capture whose out-of-vocabulary characters sit inside words. Ollama 0.33.3 refuses it
 * whole even with its default truncation (`embed-models.ts` says why), and with it every other
 * input sent in the same request: the content-vector drain's batch deferred on it every run.
 */
const OVERSIZE = 'deploy🐆🚚done '.repeat(700);

describe('OllamaProvider.embed on an input Ollama cannot truncate for itself', () => {
  // The shipped keep-alive, so this file leaves the shared daemon's model as the service keeps it.
  const shipped = new OllamaProvider({
    baseUrl: OLLAMA_URL,
    embedModel: DEFAULTS.models.embed,
    embedKeepAlive: DEFAULTS.ollama.embedKeepAlive,
  });

  it('returns a vector for it and leaves the other inputs of the request as they embed alone', async () => {
    const statuses: number[] = [];
    const recording = new OllamaProvider({
      baseUrl: OLLAMA_URL,
      embedModel: DEFAULTS.models.embed,
      embedKeepAlive: DEFAULTS.ollama.embedKeepAlive,
      fetchImpl: async (url, init) => {
        const response = await fetch(url, init);
        statuses.push(response.status);
        return response;
      },
    });

    const vectors = await recording.embed(['the payer sync job', OVERSIZE, 'numeric ids']);
    const alone = await shipped.embed(['the payer sync job', 'numeric ids']);
    console.log(`oversize input: embed request statuses ${statuses.join(', ')}`);

    expect(OVERSIZE.length).toBeGreaterThan(maxEmbedInputChars(DEFAULTS.models.embed));
    expect(vectors).toHaveLength(3);
    expect(vectors[1]).toHaveLength(DEFAULTS.models.embedDimension);
    expect(cosine(vectors[0]!, alone[0]!)).toBeCloseTo(1, 6);
    expect(cosine(vectors[2]!, alone[1]!)).toBeCloseTo(1, 6);
  }, 120_000);
});
