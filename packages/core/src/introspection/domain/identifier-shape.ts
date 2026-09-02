/**
 * Deterministic shape detection for machine-minted identifiers (a git SHA, a UUID, a file
 * path, a subagent id) that reach the graph as extracted entities and never age. The
 * no-heuristic-text-machinery rule bars regex classification from the cognitive path (cue
 * extraction, ranking, activation); this is capture/maintenance bookkeeping instead, the same
 * class as redaction's deterministic scan, and it feeds only `identifier_decay`'s eligibility
 * check, never a ranking or activation decision.
 *
 * Every shape below is conservative on purpose: it must be unambiguous on the name alone, so a
 * plain word never matches. The entity's type is not read: the name shapes settle it.
 */

export type IdentifierShape = 'sha' | 'uuid' | 'path' | 'agent_id' | 'none';

/** Git's two hex digest lengths (SHA-1, SHA-256), the full digest only, never a short prefix. */
const SHA_SHAPE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Claude Code subagent id: the literal `code-Na` prefix over a hex tail. Not pinned from a
 * sample this repo carries, so it is deliberately narrow: a coincidental name is never worth
 * matching.
 */
const AGENT_ID_SHAPE = /^code-Na[0-9a-f]{6,}$/i;

/** Two or more separators is "path-like"; one is not enough to rule out ordinary prose. */
const MIN_PATH_SEPARATORS = 2;

function countSeparators(value: string): number {
  const forward = value.match(/\//g)?.length ?? 0;
  const back = value.match(/\\/g)?.length ?? 0;
  return forward + back;
}

/** Whitespace rules out prose ("either/or, then decide") that happens to carry a slash. */
function looksLikePath(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) {
    return false;
  }
  return countSeparators(value) >= MIN_PATH_SEPARATORS;
}

export function identifierShape(name: string): IdentifierShape {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'none';
  }
  if (SHA_SHAPE.test(trimmed)) {
    return 'sha';
  }
  if (UUID_SHAPE.test(trimmed)) {
    return 'uuid';
  }
  if (AGENT_ID_SHAPE.test(trimmed)) {
    return 'agent_id';
  }
  if (looksLikePath(trimmed)) {
    return 'path';
  }
  return 'none';
}
