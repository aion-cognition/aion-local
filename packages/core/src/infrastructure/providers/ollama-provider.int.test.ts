import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config/defaults.js';
import { OllamaProvider } from './ollama-provider.js';
import type { Vector } from './types.js';

/**
 * The one property every embedding-driven decision rests on: two different names must embed
 * differently. Ollama's `nomic-embed-text` collapses any word carrying an uppercase letter
 * onto a single out-of-vocabulary token, so without the provider's case fold this file's
 * first assertion returns a cosine of exactly 1.0 for two unrelated proper nouns — and entity
 * dedup, whose threshold is a rescaled cosine over name embeddings, merges every same-typed
 * entity in the graph.
 *
 * Structural, not semantic: nothing here asserts what the model thinks two names mean, only
 * that it distinguishes them at all.
 */

const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

/** `vector.similarity.cosine` rescales onto [0,1]; entity dedup converts back with this. */
function dedupScore(left: Vector, right: Vector): number {
  return 2 * cosine(left, right) - 1;
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
    expect(dedupScore(redis as Vector, postgres as Vector)).toBeLessThan(
      DEFAULTS.reflection.entityDedupThreshold,
    );
    expect(dedupScore(person as Vector, otherPerson as Vector)).toBeLessThan(
      DEFAULTS.reflection.entityDedupThreshold,
    );
  }, 60_000);

  it('still clears the threshold for a genuine near-duplicate name', async () => {
    const [plural, singular] = await provider.embed(['numeric ids', 'numeric id']);
    expect(plural).toBeDefined();
    expect(singular).toBeDefined();
    expect(dedupScore(plural as Vector, singular as Vector)).toBeGreaterThanOrEqual(
      DEFAULTS.reflection.entityDedupThreshold,
    );
  }, 60_000);
});
