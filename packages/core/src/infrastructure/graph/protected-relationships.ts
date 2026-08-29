import type { RelationshipType } from './relationships.js';

/**
 * The relationship types plasticity leaves alone: never reinforced, never decayed, never
 * pruned. Two families sit here for different reasons.
 *
 * The backbone types are the graph's own wiring. Every session hangs off the same member and
 * the same workspace, so a weight on one of those edges states a fact about the schema rather
 * than about anything that was learned, and use is not evidence for it.
 *
 * The provenance and lineage types record what happened: which episode produced a node, which
 * session came after which, what replaced what. A record does not get truer with use or
 * falser with neglect, and a decayed provenance edge would make the trail behind an answer
 * weaker than the answer.
 *
 * Reinforcement and decay both read this list, which is why it lives beside the catalog
 * rather than inside either operation.
 */
export const PROTECTED_RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  'PARTICIPATES_IN',
  'FOLLOWS',
  'SUPERSEDES',
  'SUMMARIZED_BY',
  'DERIVES_FROM',
  'EXTRACTED_FROM',
  'INITIATED_BY',
  'WITHIN_WORKSPACE',
  'HAS_MEMBER',
  'HAS_WORKSPACE',
];

/** Takes a plain string so a type read back from Cypher can be checked without a cast. */
export function isProtectedRelationshipType(type: string): boolean {
  return (PROTECTED_RELATIONSHIP_TYPES as readonly string[]).includes(type);
}
