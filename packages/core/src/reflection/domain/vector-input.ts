import { createHash } from 'node:crypto';

/**
 * What gets embedded, and how a stored vector is known to have gone stale. Every vector write
 * stores the hash of the exact string it was taken over, so staleness is a fact the node
 * carries rather than something a writer has to remember to announce. Without it a name is
 * embedded once and never again, which loses nomination recall for exactly the identities that
 * accumulate aliases, and an embedding-model swap has no way to say what needs redoing.
 */

export function vectorInputHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The text an entity's `name_vec` is taken over: the identity's folded name and every lookup
 * key it answers to, one per line. The aliases belong in it because this vector is what
 * nominates duplicates, and an identity that has absorbed "PostgreSQL" should be found by
 * someone searching for it. Sorted and deduplicated against each other and against the name,
 * so one alias set always produces one string and therefore one hash: an alias list that
 * repeats the identity's own name would otherwise embed a different string and re-embed on
 * every mention.
 */
export function entityNameVectorText(nameNorm: string, aliasesNorm: readonly string[]): string {
  const aliases = [...new Set(aliasesNorm)].filter((alias) => alias !== nameNorm).sort();
  return [nameNorm, ...aliases].join('\n');
}
