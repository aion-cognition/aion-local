/**
 * Companion labels are a schema contract, not decoration. `Memory` is the only mechanism
 * that lets one vector index cover several node types, because a Neo4j vector index cannot
 * span a label union; `Entity` is what puts the backbone nodes under the composite
 * `(name_norm, type)` uniqueness constraint. Migration 001 declares indexes and constraints
 * against those labels, so a node written without them is invisible to both.
 * Cognitive node types extend this table rather than writing their labels by hand.
 */

export type NodeLabel =
  | 'Session'
  | 'Episode'
  | 'Turn'
  | 'Entity'
  | 'Member'
  | 'Workspace'
  | 'Narrative'
  | 'Goal'
  | 'Plan'
  | 'Decision'
  | 'Insight'
  | 'Concept'
  | 'Context'
  | 'Event'
  | 'Pattern'
  | 'Trend'
  | 'Bridge';

/**
 * Carried by every node, whatever its type, so a lookup by id alone can seek an index:
 * Neo4j indexes are label-scoped and there is no label-free property index, so the
 * type-agnostic id matches (both edge endpoints, the supersession close) would otherwise
 * plan as all-nodes scans. Migration 001 declares the uniqueness constraint behind it.
 */
export const BASE_NODE_LABEL = 'AionNode';

export const NODE_LABELS: readonly NodeLabel[] = [
  'Session',
  'Episode',
  'Turn',
  'Entity',
  'Member',
  'Workspace',
  'Narrative',
  'Goal',
  'Plan',
  'Decision',
  'Insight',
  'Concept',
  'Context',
  'Event',
  'Pattern',
  'Trend',
  'Bridge',
];

/**
 * The nine cognitive types plus Narrative and Bridge (the pinned label table) all carry
 * `Memory`: they are content-bearing, so `content_vec_idx`/`context_vec_idx` and the
 * currency range indexes, all declared `FOR (n:Memory)` in migration 001, cover them
 * without a new index per label.
 *
 * `Entity` joins them once reflection writes entity content vectors: entities are recall
 * citizens, and the recency strategy biases toward recently mentioned ones, which is
 * `Memory` in both cases.
 */
const COMPANION_LABELS: Record<NodeLabel, readonly string[]> = {
  Session: [],
  Episode: ['Memory'],
  Turn: ['Memory'],
  Entity: ['Memory'],
  // The backbone stays out of `Memory`: the Member and the global Workspace are connectivity,
  // not content, and the recency strategy reads `Memory` directly.
  Member: ['Entity'],
  Workspace: ['Entity'],
  Narrative: ['Memory'],
  Goal: ['Memory'],
  Plan: ['Memory'],
  Decision: ['Memory'],
  Insight: ['Memory'],
  Concept: ['Memory'],
  Context: ['Memory'],
  Event: ['Memory'],
  Pattern: ['Memory'],
  Trend: ['Memory'],
  Bridge: ['Memory'],
};

/** Primary label first, then its companions, then the base label. Used verbatim in the Cypher label list. */
export function resolveLabels(primary: NodeLabel): readonly string[] {
  return [primary, ...COMPANION_LABELS[primary], BASE_NODE_LABEL];
}

/** True when the label's nodes carry `Memory` and therefore land in the vector and currency indexes. */
export function isContentBearing(primary: NodeLabel): boolean {
  return COMPANION_LABELS[primary].includes('Memory');
}

export function isNodeLabel(value: string): value is NodeLabel {
  return (NODE_LABELS as readonly string[]).includes(value);
}
