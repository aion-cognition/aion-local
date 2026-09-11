import { createHash } from 'node:crypto';

/**
 * What may be removed when a source's raw projection goes, decided before anything is written.
 *
 * Membership is not proof. An edge is disposable only because its category says so and the
 * durable record that outlives it is already there; everything else blocks the source by name.
 * The classifier therefore answers three things and never a fourth: this edge is the raw
 * backbone and its identity/order is captured elsewhere, this edge is the physical face of a
 * logical fact the durable records hold under a named role, or this edge is a disposable
 * association whose retained neighbour owes a recomputation. Anything the table below does not
 * reach is a refusal with a reason, because inferring disposable from unprotected is how a
 * category nobody classified gets deleted once and understood afterwards.
 */

/** The internal wiring intake writes: turn to episode, episode to session, turn to turn. */
const CONTAINMENT = 'PARTICIPATES_IN';
const ORDER = 'FOLLOWS';

/** Roles the durable records carry for a raw endpoint, one per preserved category. */
export const EVICTION_ROLES = {
  extraction: 'extraction',
  mention: 'mention',
  participation: 'participation',
  coverage: 'source_coverage',
  confirmation: 'stated_confirmation',
  correction: 'stated_correction',
  derivation: 'stated_derivation',
} as const;

/**
 * Edge properties a preserved-field digest ignores, named here rather than filtered anywhere
 * else. Both are access-only stamps: a read moves them, they carry no evidence, and they cannot
 * change an eligibility answer. Every other property is preserved, so a plasticity write between
 * nomination and the guard invalidates the attempt rather than passing through it.
 */
export const EVICTION_IGNORED_EDGE_FIELDS: readonly string[] = ['last_accessed_at', 'access_count'];

/** Bumped only when the ignored set above changes; the manifest records what it was bound to. */
export const IGNORED_FIELD_POLICY_REVISION = 1;

/** C9 §4's internal attempt bounds. One source, and what one source may carry. */
export const EVICTION_BOUNDS = {
  /** One Episode plus C7's `turns.max(200)`. */
  nodes: 201,
  edges: 4096,
  manifestBytes: 2 * 1024 * 1024,
} as const;

export type EvictionNode = {
  readonly id: string;
  readonly labels: readonly string[];
};

/** One incident relationship as the census read it, with the endpoint that sits in the set named. */
export type IncidentEdge = {
  readonly relationId: string;
  readonly type: string;
  readonly fromId: string;
  readonly toId: string;
  /** The removal-set endpoint. Both ends when the edge is internal to the set. */
  readonly insideIds: readonly string[];
  /** The endpoint outside the set, absent for an internal edge. */
  readonly outsideId?: string;
  readonly outsideLabels: readonly string[];
  readonly provenance: readonly string[];
  /** Every preserved property, canonical, so a changed payload is a changed digest. */
  readonly properties: Readonly<Record<string, unknown>>;
};

export type EdgeDisposition =
  | { readonly category: 'raw_backbone' }
  | { readonly category: 'preserved_evidence'; readonly role: string; readonly nodeId: string }
  | { readonly category: 'disposable_association'; readonly survivorId: string }
  | { readonly category: 'block'; readonly reason: string };

/** The association writers whose edges are physical projections rather than assertions. */
const DISPOSABLE_ASSOCIATION_TYPES: readonly string[] = ['CO_OCCURS'];

/**
 * Types whose presence in the catalog proves nothing about this endpoint combination. Named
 * rather than defaulted, so a reader can see that the refusal is deliberate and which entry of
 * the taxonomy owes the classification.
 */
const UNCLASSIFIED_AT_RAW_ENDPOINTS: readonly string[] = [
  'SIMILAR',
  'RELATED_TO',
  'ANALOGOUS_TO',
  'CAUSES',
  'ENABLES',
  'PRECEDES',
  'EXEMPLIFIES',
  'BELONGS_TO',
  'ADDRESSES',
  'BASED_ON',
  'REQUIRES',
  'INCLUDES_EVENT',
  'FEATURED_IN',
];

const SEMANTIC_STATE_TYPES: readonly string[] = ['SUPERSEDES', 'CONTRADICTS', 'CORRECTS'];

const STRUCTURAL_TYPES: readonly string[] = [
  'HAS_WORKSPACE',
  'HAS_MEMBER',
  'WITHIN_WORKSPACE',
  'INITIATED_BY',
];

function has(labels: readonly string[], label: string): boolean {
  return labels.includes(label);
}

/**
 * An edge with both ends inside the removal set.
 *
 * Only the two shapes intake writes are expected here. A third one means something reached
 * inside a source's own projection and wrote a relation this classifier has never seen, which is
 * exactly the case that must stop rather than be swept up with the set it happens to sit in.
 */
function internalDisposition(edge: IncidentEdge): EdgeDisposition {
  if (edge.type === CONTAINMENT || edge.type === ORDER) {
    return { category: 'raw_backbone' };
  }
  return { category: 'block', reason: `unexpected_internal_${edge.type.toLowerCase()}` };
}

/**
 * The classifier proper: one incident edge, one disposition, and a named reason whenever the
 * answer is no.
 *
 * The order of the tests is the order the taxonomy reads. Structural and semantic-state types
 * come before the preserved roles because a `SUPERSEDES` touching a raw node is a decision about
 * the world that no adapted consumer reads from an archive yet, and a `FOLLOWS` whose other end
 * is outside this source's family is the cross-family order edge the current writer cannot
 * produce — both refuse rather than being carried as ordinary categories.
 */
export function classifyIncidentEdge(edge: IncidentEdge): EdgeDisposition {
  if (edge.outsideId === undefined) {
    return internalDisposition(edge);
  }
  const outside = edge.outsideId;
  if (SEMANTIC_STATE_TYPES.includes(edge.type) && edge.type !== 'CORRECTS') {
    return { category: 'block', reason: `semantic_state_${edge.type.toLowerCase()}` };
  }
  if (STRUCTURAL_TYPES.includes(edge.type)) {
    return { category: 'block', reason: `structural_at_raw_endpoint_${edge.type.toLowerCase()}` };
  }
  if (edge.type === ORDER) {
    // previousTurnId resets inside each Episode, so an order edge reaching another family is a
    // shape v1's writer cannot produce and v1 does not know how to preserve.
    return { category: 'block', reason: 'follows_crosses_source_family' };
  }
  if (edge.type === CONTAINMENT) {
    if (has(edge.outsideLabels, 'Session')) {
      return { category: 'raw_backbone' };
    }
    if (has(edge.outsideLabels, 'Entity')) {
      return {
        category: 'preserved_evidence',
        role: EVICTION_ROLES.participation,
        nodeId: outside,
      };
    }
    return { category: 'block', reason: 'participation_endpoint_unclassified' };
  }
  if (edge.type === 'EXTRACTED_FROM') {
    return { category: 'preserved_evidence', role: EVICTION_ROLES.extraction, nodeId: outside };
  }
  if (edge.type === 'MENTIONS') {
    return { category: 'preserved_evidence', role: EVICTION_ROLES.mention, nodeId: outside };
  }
  if (edge.type === 'SUMMARIZED_BY') {
    return { category: 'preserved_evidence', role: EVICTION_ROLES.coverage, nodeId: outside };
  }
  if (edge.type === 'EVIDENCES') {
    return { category: 'preserved_evidence', role: EVICTION_ROLES.confirmation, nodeId: outside };
  }
  if (edge.type === 'CORRECTS') {
    return { category: 'preserved_evidence', role: EVICTION_ROLES.correction, nodeId: outside };
  }
  if (edge.type === 'DERIVES_FROM') {
    return { category: 'preserved_evidence', role: EVICTION_ROLES.derivation, nodeId: outside };
  }
  if (DISPOSABLE_ASSOCIATION_TYPES.includes(edge.type)) {
    return { category: 'disposable_association', survivorId: outside };
  }
  if (UNCLASSIFIED_AT_RAW_ENDPOINTS.includes(edge.type)) {
    return { category: 'block', reason: `unclassified_role_${edge.type.toLowerCase()}` };
  }
  return { category: 'block', reason: 'unknown_relationship_type' };
}

/** One edge's preserved payload, canonical and ignoring exactly the named access-only fields. */
export function preservedEdgeDigest(edge: IncidentEdge): string {
  const preserved = Object.keys(edge.properties)
    .filter((key) => !EVICTION_IGNORED_EDGE_FIELDS.includes(key))
    .sort()
    .map((key) => [key, edge.properties[key]] as const);
  return createHash('sha256')
    .update(JSON.stringify([edge.relationId, edge.type, edge.fromId, edge.toId, preserved]))
    .digest('hex');
}

export type ClassifiedEdge = {
  readonly edge: IncidentEdge;
  readonly disposition: EdgeDisposition;
  readonly digest: string;
};

export type EvictionClassification =
  | {
      readonly status: 'classified';
      readonly edges: readonly ClassifiedEdge[];
      /** Every (node, role) pair a durable record has to carry before its edge may go. */
      readonly required: readonly { readonly nodeId: string; readonly role: string }[];
      readonly survivorIds: readonly string[];
      /** The category digest bound into the intent; a changed category changes it. */
      readonly categoryDigest: string;
    }
  | { readonly status: 'blocked'; readonly reason: string; readonly relationId: string };

/**
 * Every incident edge classified, or the first refusal with the relationship that caused it.
 *
 * It stops at the first block on purpose: the source is pinned either way, and enumerating the
 * rest would report a longer list of consequences of the same unclassified category.
 */
export function classifyRemovalSet(edges: readonly IncidentEdge[]): EvictionClassification {
  const classified: ClassifiedEdge[] = [];
  const required: { nodeId: string; role: string }[] = [];
  const survivors = new Set<string>();
  for (const edge of edges) {
    if (edge.relationId === '') {
      return { status: 'blocked', reason: 'edge_identity_missing', relationId: edge.type };
    }
    const disposition = classifyIncidentEdge(edge);
    if (disposition.category === 'block') {
      return { status: 'blocked', reason: disposition.reason, relationId: edge.relationId };
    }
    if (disposition.category === 'preserved_evidence') {
      required.push({ nodeId: disposition.nodeId, role: disposition.role });
    }
    if (disposition.category === 'disposable_association') {
      survivors.add(disposition.survivorId);
    }
    classified.push({ edge, disposition, digest: preservedEdgeDigest(edge) });
  }
  return {
    status: 'classified',
    edges: classified,
    required,
    survivorIds: [...survivors].sort(),
    categoryDigest: categoryDigestOf(classified),
  };
}

/** The category/property digest C9 §3 requires: identity, category and preserved payload, sorted. */
export function categoryDigestOf(edges: readonly ClassifiedEdge[]): string {
  const rows = edges
    .map((entry) => [
      entry.edge.relationId,
      entry.edge.type,
      entry.disposition.category,
      entry.digest,
    ])
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return createHash('sha256')
    .update(JSON.stringify([IGNORED_FIELD_POLICY_REVISION, rows]))
    .digest('hex');
}

/** Node identities and labels, sorted, so the set the guard rechecks is comparable as a value. */
export function nodeSetDigest(nodes: readonly EvictionNode[]): string {
  const rows = nodes
    .map((node) => [node.id, [...node.labels].sort()] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function sortedIdentities(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

/** Whether the removal set fits one guarded attempt, and which bound it broke. */
export function removalSetBound(nodes: number, edges: number): string | undefined {
  if (nodes > EVICTION_BOUNDS.nodes) {
    return 'removal_set_nodes_bound';
  }
  if (edges > EVICTION_BOUNDS.edges) {
    return 'removal_set_edges_bound';
  }
  return undefined;
}
