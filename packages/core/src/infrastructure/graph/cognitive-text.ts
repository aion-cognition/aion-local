/**
 * The stored fold behind every cognitive node's text, and the property it lands on. It sits
 * below `cognitive-queries.ts` rather than inside it because the query modules the cognitive
 * write itself depends on read the same two symbols: with them declared next to the writer,
 * the write path and the modules it calls import each other, and the module evaluated first
 * reads the other's constants before they exist.
 */

/** Stored alongside `text` so a future reader can match on it without recomputing the fold. */
export const TEXT_NORM_PROPERTY = 'text_norm';

/**
 * Collapses whitespace and lowercases. Not the identity fold: it skips the NFKC and case
 * folding `name-fold.ts` applies, so two spellings that differ by a compatibility form mint
 * two cognitive node ids. A key that has to match an entity's identity uses `foldForIdentity`
 * instead, which is what `claim-key.ts` says about its own fold.
 */
export function normalizeCognitiveText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
