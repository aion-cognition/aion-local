/**
 * Companion labels are a schema contract, not decoration. `Memory` is the only mechanism
 * that lets one vector index cover several node types, because a Neo4j vector index cannot
 * span a label union; `Entity` is what puts the backbone nodes under the composite
 * `(name_norm, type)` uniqueness constraint. Migration 001 declares indexes and constraints
 * against those labels, so a node written without them is invisible to both.
 * P3's cognitive node types extend this table rather than writing their labels by hand.
 */

export type NodeLabel = 'Session' | 'Episode' | 'Turn' | 'Entity' | 'Member' | 'Workspace';

export const NODE_LABELS: readonly NodeLabel[] = [
  'Session',
  'Episode',
  'Turn',
  'Entity',
  'Member',
  'Workspace',
];

const COMPANION_LABELS: Record<NodeLabel, readonly string[]> = {
  Session: [],
  Episode: ['Memory'],
  Turn: ['Memory'],
  Entity: [],
  Member: ['Entity'],
  Workspace: ['Entity'],
};

/** Primary label first, then its companions. Used verbatim in the Cypher label list. */
export function resolveLabels(primary: NodeLabel): readonly string[] {
  return [primary, ...COMPANION_LABELS[primary]];
}

/** True when the label's nodes carry `Memory` and therefore land in the vector and currency indexes. */
export function isContentBearing(primary: NodeLabel): boolean {
  return COMPANION_LABELS[primary].includes('Memory');
}

export function isNodeLabel(value: string): value is NodeLabel {
  return (NODE_LABELS as readonly string[]).includes(value);
}
