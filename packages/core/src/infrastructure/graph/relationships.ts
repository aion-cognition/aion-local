/**
 * Whitepaper Appendix C, plus `SUPERSEDES` — this build's bitemporal extension (PRD §5.5).
 * A relationship type cannot be a Cypher parameter, so it is interpolated into the query
 * text; every write path validates against this catalog first, which is what keeps the
 * interpolation injection-free.
 */

export const UNDIRECTED_RELATIONSHIP_TYPES = [
  'SIMILAR',
  'CO_OCCURS',
  'RELATED_TO',
  'ANALOGOUS_TO',
  // Undirected because tension is mutual: whitepaper §6.8 reads it as "two entities or
  // claims are in tension", which is the same claim whichever end it is written from.
  'CONTRADICTS',
] as const;

export const DIRECTED_RELATIONSHIP_TYPES = [
  'PARTICIPATES_IN',
  'INCLUDES_EVENT',
  'MENTIONS',
  'CAUSES',
  'ENABLES',
  'PRECEDES',
  'EXEMPLIFIES',
  'BELONGS_TO',
  'EVIDENCES',
  'SUMMARIZED_BY',
  'DERIVES_FROM',
  'ADDRESSES',
  'BASED_ON',
  'REQUIRES',
  'HAS_WORKSPACE',
  'HAS_MEMBER',
  'WITHIN_WORKSPACE',
  'INITIATED_BY',
  'FOLLOWS',
  'EXTRACTED_FROM',
  'FEATURED_IN',
  'SUPERSEDES',
] as const;

export type UndirectedRelationshipType = (typeof UNDIRECTED_RELATIONSHIP_TYPES)[number];
export type DirectedRelationshipType = (typeof DIRECTED_RELATIONSHIP_TYPES)[number];
export type RelationshipType = UndirectedRelationshipType | DirectedRelationshipType;

export const RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  ...UNDIRECTED_RELATIONSHIP_TYPES,
  ...DIRECTED_RELATIONSHIP_TYPES,
];

/** The edge a replacement node points at the node it replaced: `(new)-[:SUPERSEDES]->(old)`. */
export const SUPERSEDES_TYPE = 'SUPERSEDES';

export function isRelationshipType(value: string): value is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

export function isUndirectedRelationshipType(type: RelationshipType): boolean {
  return (UNDIRECTED_RELATIONSHIP_TYPES as readonly string[]).includes(type);
}

export type Endpoints = {
  readonly sourceId: string;
  readonly targetId: string;
};

/**
 * Undirected types are stored as a directed edge with a canonical endpoint order, because
 * MERGE matches on direction: writing A→B and then B→A for the same undirected type would
 * otherwise leave two edges standing for one relationship (verified against a live server).
 */
export function normalizeEndpoints(type: RelationshipType, endpoints: Endpoints): Endpoints {
  if (!isUndirectedRelationshipType(type) || endpoints.sourceId <= endpoints.targetId) {
    return endpoints;
  }
  return { sourceId: endpoints.targetId, targetId: endpoints.sourceId };
}
