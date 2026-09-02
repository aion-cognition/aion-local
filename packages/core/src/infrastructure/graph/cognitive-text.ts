/**
 * The stored fold behind every cognitive node's text, and the property it lands on. It sits
 * below `cognitive-queries.ts` rather than inside it because the query modules the cognitive
 * write itself depends on read the same two symbols: with them declared next to the writer,
 * the write path and the modules it calls import each other, and the module evaluated first
 * reads the other's constants before they exist.
 */

/** Stored alongside `text` so a future reader can match on it without recomputing the fold. */
export const TEXT_NORM_PROPERTY = 'text_norm';

/** Collapses whitespace and lowercases, matching `backbone.ts`'s entity-name normalization. */
export function normalizeCognitiveText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
