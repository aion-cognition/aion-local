/**
 * The single fold behind every identity comparison in the product: the text an embedding is
 * computed over, and the `name_norm` key the graph's `(name_norm, type)` uniqueness
 * constraint is declared on. Both sides of a comparison have to fold identically, or a stored
 * vector scores against a differently-tokenized query and a re-extracted name forks a second
 * node. Every writer of `name_norm` calls `foldName`; the embedding path calls
 * `foldForIdentity` on whole text.
 *
 * Measured against Ollama 0.24.0 + `nomic-embed-text`: every word carrying an uppercase
 * letter tokenizes to one out-of-vocabulary token, so `Redis`, `Dog` and `Thandiwe Baptiste`
 * returned the same 768 floats byte for byte while their lowercase forms embedded distinctly.
 * A plain `toLowerCase` closed that class and left the rest: `Ａ` (fullwidth), `ﬁ` (ligature)
 * and `ß` still fold to something a lowercase mapping alone does not reach.
 *
 * NFKC first, so a compatibility form reduces to its canonical spelling. Then case folding —
 * Unicode's case-insensitive matching operation, which `toLowerCase` implements except for the
 * multi-character mappings in `CASE_FOLD_EXCEPTIONS`. Then NFKC again, because a lowercase
 * mapping can produce a decomposable form.
 *
 * Whole-text folding, not term derivation: nothing is split, stemmed, transliterated, or
 * dropped. Diacritics survive on purpose — `resume` and `résumé` are different names, and the
 * embedding model collapsing them is a model property this fold must not paper over.
 */

const CASE_FOLD_EXCEPTIONS: readonly (readonly [RegExp, string])[] = [
  // ß and ẞ: full case folding maps both to `ss`; `toLowerCase` stops at ß.
  [/ß/g, 'ss'],
  // Final sigma folds to the medial form, so `ΟΔΟΣ`, `οδος` and `οδός`-less `οδοσ` all meet.
  [/ς/g, 'σ'],
];

export function foldForIdentity(text: string): string {
  let folded = text.normalize('NFKC').toLowerCase();
  for (const [pattern, replacement] of CASE_FOLD_EXCEPTIONS) {
    folded = folded.replace(pattern, replacement);
  }
  return folded.normalize('NFKC');
}

/**
 * The identity fold plus the whitespace collapse a name key needs. Folding runs first because
 * NFKC turns several compatibility spaces (NBSP, ideographic space) into plain ones, which the
 * collapse then absorbs.
 */
export function foldName(name: string): string {
  return foldForIdentity(name)
    .trim()
    .replace(/\s+/g, ' ');
}
