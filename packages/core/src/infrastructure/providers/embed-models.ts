/**
 * What each embed model can take, and how it wants a query spelled. One row per model, so a
 * model swap is a knob plus a row rather than a hunt through call sites.
 *
 * Ollama rejects an over-length embed input with a 400 and does not truncate it; `truncate:
 * true` does not save it, and one rejected input fails its whole batch. The cap therefore has
 * to hold for every input rather than on average, which is why it is derived from the window
 * instead of guessed from average token density.
 *
 * The derivation: a subword token spans at least one character, and the encoder spends two
 * positions of the window on its own start and end tokens. Measured against Ollama 0.24.0,
 * nomic-embed-text takes 2046 single-token characters and rejects 2047.
 *
 * The cap is a guarantee for text that costs at most one token per character, which covers the
 * Latin text this pipeline embeds. A multilingual tokenizer can spend more than one token on
 * one character: snowflake-arctic-embed2 filled its 8192-token window with 4566 Devanagari
 * characters. Dense non-Latin content can still draw the 400, and sizing content where it is
 * generated is what closes that, not a smaller cap here.
 */
export type EmbedModelProfile = {
  /** The model's context window, in tokens. */
  readonly contextTokens: number;
  /**
   * Prepended to a recall query and to nothing else. A model trained on asymmetric retrieval
   * saw queries marked and documents bare, so a stored vector, a name vector, and every
   * symmetric comparison stay raw: prefixing both sides compresses the gap the comparison
   * reads. An empty prefix is the ordinary case.
   */
  readonly queryPrefix: string;
};

/** The encoder's start and end tokens, which no input text gets to use. */
const SPECIAL_TOKENS = 2;

/**
 * The name of the row that carries a prefix, and a name no model answers to. Every measured row
 * is empty, so without this one `${queryPrefix}${text}` at the five call sites composes to the
 * text itself and a build with the composition deleted passes every test that exists. Tests name
 * this model to embed a query through the same table a run does; nothing configures it.
 */
export const QUERY_PREFIX_SEAM_MODEL = 'aion-query-prefix-seam';

const PROFILES: Readonly<Record<string, EmbedModelProfile>> = {
  'nomic-embed-text': { contextTokens: 2048, queryPrefix: '' },
  // arctic2 ships a "query: " retrieval prefix and this install does not use it. Measured
  // against the admission fixtures on 2026-09-01, query side prefixed and content side raw:
  // unrelated p95 0.210 max 0.224, related min 0.233 p50 0.634, half the genuine matches under
  // the committed 0.60 floor. Raw on both sides: unrelated p95 0.285 max 0.299, related min
  // 0.382 p50 0.769, 30% under it. The prefix compresses the band the floor reads, on the
  // asymmetric shape it is meant for. Phase 4.4 re-derives the floors and owns this row;
  // whichever way it goes, one row decides it for every query-shaped embed in the product.
  'snowflake-arctic-embed2': { contextTokens: 8192, queryPrefix: '' },
  // The prefix arctic2 ships, on the seam name, so the composition every call site performs is
  // exercised while every configurable row is still raw. Phase 4.4 decides on this string.
  [QUERY_PREFIX_SEAM_MODEL]: { contextTokens: 2048, queryPrefix: 'query: ' },
};

/** A model nobody measured gets the narrowest window in the table and no prefix. */
const UNLISTED: EmbedModelProfile = { contextTokens: 2048, queryPrefix: '' };

/** The name without the tag, since `model` and `model:latest` are one model to Ollama. */
function profileFor(model: string): EmbedModelProfile {
  const name = model.toLowerCase().split(':')[0] ?? '';
  return PROFILES[name] ?? UNLISTED;
}

export function maxEmbedInputChars(model: string): number {
  return profileFor(model).contextTokens - SPECIAL_TOKENS;
}

export function embedQueryPrefix(model: string): string {
  return profileFor(model).queryPrefix;
}
