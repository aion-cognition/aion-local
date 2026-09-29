/**
 * What each embed model can take, and how it wants a query spelled. One row per model, so a
 * model swap is a knob plus a row rather than a hunt through call sites.
 *
 * The character cap is derived from the model's window: a subword token spans at least one
 * character, and the encoder spends two positions on its own start and end tokens. Measured
 * against Ollama 0.24.0, nomic-embed-text took 2046 single-token characters and rejected 2047.
 *
 * The window Ollama runs the model at can be narrower than the model's own, so the cap does not
 * guarantee an input fits. Measured on the local Ollama 0.33.3 (2026-09-29), the runner embeds
 * at most 2,048 tokens of snowflake-arctic-embed2's 8,192, and its default truncation cuts
 * longer text to that. The cut text is re-tokenized after each out-of-vocabulary character has
 * come back as the literal `<unk>`, which can re-tokenize to more tokens than the character did,
 * so text such as `deploy🐆🚚done` repeated is still refused with a 400, and one refused input
 * fails its whole request. `OllamaProvider.embed` answers that refusal by shortening the input
 * that drew it.
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

const PROFILES: ReadonlyMap<string, EmbedModelProfile> = new Map([
  ['nomic-embed-text', { contextTokens: 2048, queryPrefix: '' }],
  // arctic2 ships a "query: " retrieval prefix and this install does not use it. Both spellings
  // were re-measured against the admission fixtures on 2026-09-02, cue side prefixed and content
  // side raw against both sides raw. What decides it is the gap the admission floor has to sit
  // in, not either band's own numbers: raw leaves unrelated at max 0.299 and the weakest genuine
  // match at 0.382, a valley 0.083 wide, which is what the committed 0.35 floor is derived from.
  // Prefixed leaves unrelated at max 0.224 and the weakest genuine match at 0.233, a valley
  // 0.009 wide, narrower than the 0.03 drift the calibration allows a floor. The prefix
  // compresses the separation the floor reads, on the asymmetric shape it is meant for, so the
  // row stays empty and every query-shaped embed in the product goes out raw.
  ['snowflake-arctic-embed2', { contextTokens: 8192, queryPrefix: '' }],
  // The prefix arctic2 ships, on the seam name, so the composition every call site performs is
  // exercised while every configurable row is still raw. The string lives here and nowhere else,
  // since the seam has to stay testable while no shipped row carries a prefix.
  [QUERY_PREFIX_SEAM_MODEL, { contextTokens: 2048, queryPrefix: 'query: ' }],
]);

/** A model nobody measured gets the narrowest window in the table and no prefix. */
const UNLISTED: EmbedModelProfile = { contextTokens: 2048, queryPrefix: '' };

/**
 * The name without the tag, since `model` and `model:latest` are one model to Ollama. A Map
 * rather than an object literal, so a configured model named after an `Object.prototype` key
 * reads as unlisted instead of returning the prototype member.
 */
function profileFor(model: string): EmbedModelProfile {
  const name = model.toLowerCase().split(':')[0] ?? '';
  return PROFILES.get(name) ?? UNLISTED;
}

export function maxEmbedInputChars(model: string): number {
  return profileFor(model).contextTokens - SPECIAL_TOKENS;
}

/**
 * The first `maxChars` UTF-16 units of `text`, one fewer where the cut would split a surrogate
 * pair: a lone half reaches Ollama as a replacement character the text never held.
 */
export function embedPrefix(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const end = Math.max(0, maxChars);
  const last = text.charCodeAt(end - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? end - 1 : end);
}

export function embedQueryPrefix(model: string): string {
  return profileFor(model).queryPrefix;
}
