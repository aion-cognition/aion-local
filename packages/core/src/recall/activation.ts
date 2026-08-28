import type { AdjacencyNeighbor } from '../graph/adjacency.js';
import type { CurrencyAnnotation } from '../graph/read-modes.js';
import { isRelationshipType, type RelationshipType } from '../graph/relationships.js';

/**
 * Whitepaper §5.4, Algorithm 2, run in TypeScript over batched adjacency reads. The graph
 * is asked one question per frontier iteration; everything else — weighting, accumulation,
 * inhibition, termination — happens here, where it is testable without a server.
 */

/** Whitepaper §5.4: every seed enters the spread at full activation. */
export const SEED_ACTIVATION = 1;

/**
 * Tuned propagation multipliers per relationship type, all in [0,1]. The tiers below are
 * the tuning: a type's multiplier says how much of a node's relevance its neighbour
 * inherits, so containment and provenance — where the neighbour is literally part of the
 * same experience — sit high, mention and semantic association sit in the middle, and
 * lineage sits low. Typed against the catalog so a new relationship type fails to compile
 * until it is given a weight rather than silently defaulting.
 */
const ACTIVATION_WEIGHTS: Record<RelationshipType, number> = {
  // Containment. A turn is part of its episode and an episode part of its session, so
  // relevance transfers almost intact; these are the edges P2's graph is mostly made of.
  PARTICIPATES_IN: 0.9,
  INCLUDES_EVENT: 0.9,
  BELONGS_TO: 0.7,

  // Provenance and compression. A narrative and its evidence are two views of one thing,
  // and traversal between them is how a summary reaches the episodes behind it.
  SUMMARIZED_BY: 0.9,
  DERIVES_FROM: 0.8,
  EVIDENCES: 0.8,
  EXTRACTED_FROM: 0.8,

  // Temporal chains. FOLLOWS is the cross-session path (whitepaper §4.2) and the only way
  // a query about today reaches last week's work, so it stays high; PRECEDES is a weaker
  // ordering claim between arbitrary nodes.
  FOLLOWS: 0.8,
  PRECEDES: 0.6,

  // Structural backbone. Every session hangs off the same member and workspace, so these
  // edges are the graph's connectivity guarantee and its worst hubs at once: held high
  // enough to bridge sessions, and left to hub inhibition to keep from flooding.
  WITHIN_WORKSPACE: 0.7,
  INITIATED_BY: 0.7,
  HAS_WORKSPACE: 0.7,
  HAS_MEMBER: 0.7,

  // Causal and cognitive structure (P3's node types). A cause carries more of its effect's
  // relevance than a mere requirement or example does.
  CAUSES: 0.7,
  BASED_ON: 0.7,
  ENABLES: 0.6,
  REQUIRES: 0.6,
  ADDRESSES: 0.6,
  EXEMPLIFIES: 0.5,

  // Mentions. Moderate by construction: an entity named in an episode is related to it,
  // but a frequently named entity would otherwise pull the whole graph into every recall.
  MENTIONS: 0.5,
  FEATURED_IN: 0.5,

  // Semantic association, the inferred tier. SIMILAR and RELATED_TO are additionally
  // scaled by strength x confidence (see EVIDENCE_SCALED_TYPES), so these are ceilings
  // rather than fixed weights; CO_OCCURS and ANALOGOUS_TO are weaker claims still.
  SIMILAR: 0.6,
  RELATED_TO: 0.5,
  CO_OCCURS: 0.5,
  ANALOGOUS_TO: 0.45,

  // Lineage. A superseded node is reachable from its replacement — that is what makes the
  // old truth recallable — but the path is deliberately weak, and the node at the far end
  // is down-weighted again by SUPERSEDED_ACTIVATION_WEIGHT.
  SUPERSEDES: 0.4,
};

/** A type outside the catalog can only come from a writer this build does not own. */
const DEFAULT_ACTIVATION_WEIGHT = 0.3;

/**
 * Whitepaper §5.4: these two are inferred rather than observed, so their propagation is
 * scaled by the evidence behind them (`strength x confidence`) instead of by type alone.
 */
const EVIDENCE_SCALED_TYPES: readonly string[] = ['SIMILAR', 'RELATED_TO'];

/**
 * Hub inhibition strength in `1 / (1 + alpha * ln(1 + degree - hubThreshold))`. At
 * `alpha = 0.5` a node ten times the threshold's connectivity keeps about a third of the
 * activation it would otherwise absorb: damped, never severed. The penalty is a function
 * of the excess over the threshold, so it is exactly 1.0 at the threshold and has no step.
 */
const HUB_INHIBITION_ALPHA = 0.5;

/**
 * PRD §5.5: superseded knowledge is down-ranked, never hidden. Half weight keeps a
 * superseded node in the spread and lets it propagate onward — a current node reachable
 * only through superseded lineage still surfaces — while ranking it under its replacement.
 * A constant rather than a knob: the ranking treatment of lineage is a property of the
 * bitemporal contract, not something an operator tunes per install.
 */
export const SUPERSEDED_ACTIVATION_WEIGHT = 0.5;

const CURRENT: CurrencyAnnotation = { currency: 'current' };

export type ActivationSeed = {
  readonly nodeId: string;
  /** From seed selection's currency-annotated read; absent is treated as current. */
  readonly currency?: CurrencyAnnotation;
};

/**
 * `config.activation` plus `config.recall.maxHops`, which bounds traversal depth for the
 * whole recall pipeline rather than for this stage alone.
 */
export type ActivationBudget = {
  readonly maxIterations: number;
  readonly decayFactor: number;
  readonly minActivation: number;
  readonly maxNodesVisited: number;
  readonly hubThreshold: number;
  readonly maxHops: number;
};

export type ActivatedNode = {
  readonly nodeId: string;
  readonly score: number;
  /** Distance along the strongest contributing path, not the shortest one. */
  readonly hops: number;
  /** `<seed> -[TYPE]-> <node> -[TYPE]-> <node>`; a seed's own summary is its id. */
  readonly pathSummary: string;
  readonly currency: CurrencyAnnotation;
};

/**
 * Why the spread stopped. Whitepaper §5.4 names three conditions; `hop_limit` is PRD
 * §6.3's bound on traversal depth and `frontier_exhausted` is the small-graph case, which
 * is the ordinary one until P3 fills the graph in.
 */
export type ActivationTermination =
  | 'frontier_exhausted'
  | 'below_min_activation'
  | 'hop_limit'
  | 'node_budget'
  | 'max_iterations';

export type ActivationRun = {
  /** Seeds included, ordered by score descending, filtered to `minActivation` and above. */
  readonly activated: readonly ActivatedNode[];
  readonly iterations: number;
  readonly nodesVisited: number;
  readonly termination: ActivationTermination;
};

/** One batched adjacency read. The caller binds the driver and the bitemporal read mode. */
export type AdjacencyFetch = (request: {
  readonly frontier: readonly string[];
  readonly visited: readonly string[];
}) => Promise<readonly AdjacencyNeighbor[]>;

export type SpreadActivationInput = {
  readonly seeds: readonly ActivationSeed[];
  readonly budget: ActivationBudget;
};

function clampProportion(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Type multiplier, scaled by the evidence behind the edge for the two inferred types.
 * Exported because the fusion stage explains activation scores with it.
 */
export function edgeWeight(neighbor: AdjacencyNeighbor): number {
  const base = isRelationshipType(neighbor.relationshipType)
    ? ACTIVATION_WEIGHTS[neighbor.relationshipType]
    : DEFAULT_ACTIVATION_WEIGHT;
  if (!EVIDENCE_SCALED_TYPES.includes(neighbor.relationshipType)) {
    return base;
  }
  return base * clampProportion(neighbor.strength) * clampProportion(neighbor.confidence);
}

/**
 * The penalty a neighbour's connectivity applies to activation arriving at it. Below the
 * threshold there is none; above it the divisor grows with the log of the excess degree,
 * so a hub's influence on the frontier falls off smoothly instead of at a cliff.
 */
export function hubInhibition(degree: number, hubThreshold: number): number {
  if (!Number.isFinite(degree) || degree <= hubThreshold) {
    return 1;
  }
  return 1 / (1 + HUB_INHIBITION_ALPHA * Math.log(1 + degree - hubThreshold));
}

type SpreadState = {
  readonly scores: Map<string, number>;
  readonly hops: Map<string, number>;
  readonly paths: Map<string, string>;
  readonly currency: Map<string, CurrencyAnnotation>;
  /** The strongest single contribution seen per node; decides which path is reported. */
  readonly strongest: Map<string, number>;
  readonly seeds: Set<string>;
  readonly visited: Set<string>;
  readonly frontier: Set<string>;
};

function initialize(seeds: readonly ActivationSeed[]): SpreadState {
  const state: SpreadState = {
    scores: new Map(),
    hops: new Map(),
    paths: new Map(),
    currency: new Map(),
    strongest: new Map(),
    seeds: new Set(),
    visited: new Set(),
    frontier: new Set(),
  };

  for (const seed of seeds) {
    if (state.seeds.has(seed.nodeId)) {
      continue;
    }
    const annotation = seed.currency ?? CURRENT;
    const superseded = annotation.currency === 'superseded';
    state.seeds.add(seed.nodeId);
    state.scores.set(
      seed.nodeId,
      superseded ? SEED_ACTIVATION * SUPERSEDED_ACTIVATION_WEIGHT : SEED_ACTIVATION,
    );
    state.hops.set(seed.nodeId, 0);
    state.paths.set(seed.nodeId, seed.nodeId);
    state.currency.set(seed.nodeId, annotation);
    state.frontier.add(seed.nodeId);
  }

  return state;
}

/**
 * `A_neighbour = A_current * w_edge * d`, hub-inhibited on arrival and halved again when
 * the neighbour is superseded. Contributions add: reaching one node down several paths is
 * the evidence-reinforces-relevance principle of whitepaper §5.4, not double counting.
 */
function propagate(state: SpreadState, neighbor: AdjacencyNeighbor, budget: ActivationBudget): void {
  const sourceScore = state.scores.get(neighbor.sourceId) ?? 0;
  const superseded = neighbor.currency.currency === 'superseded';
  const propagated =
    sourceScore *
    edgeWeight(neighbor) *
    budget.decayFactor *
    hubInhibition(neighbor.degree, budget.hubThreshold) *
    (superseded ? SUPERSEDED_ACTIVATION_WEIGHT : 1);

  if (propagated <= 0) {
    return;
  }

  state.scores.set(neighbor.nodeId, (state.scores.get(neighbor.nodeId) ?? 0) + propagated);
  state.currency.set(neighbor.nodeId, neighbor.currency);

  // A seed's origin is where the spread began; no later path rewrites it, however strong.
  if (state.seeds.has(neighbor.nodeId)) {
    return;
  }
  if (propagated <= (state.strongest.get(neighbor.nodeId) ?? 0)) {
    return;
  }

  const sourcePath = state.paths.get(neighbor.sourceId) ?? neighbor.sourceId;
  state.strongest.set(neighbor.nodeId, propagated);
  state.hops.set(neighbor.nodeId, (state.hops.get(neighbor.sourceId) ?? 0) + 1);
  state.paths.set(
    neighbor.nodeId,
    `${sourcePath} -[${neighbor.relationshipType}]-> ${neighbor.nodeId}`,
  );

  if (!state.visited.has(neighbor.nodeId)) {
    state.frontier.add(neighbor.nodeId);
  }
}

function collect(state: SpreadState, minActivation: number): ActivatedNode[] {
  const activated: ActivatedNode[] = [];
  for (const [nodeId, score] of state.scores) {
    if (score < minActivation) {
      continue;
    }
    activated.push({
      nodeId,
      score,
      hops: state.hops.get(nodeId) ?? 0,
      pathSummary: state.paths.get(nodeId) ?? nodeId,
      currency: state.currency.get(nodeId) ?? CURRENT,
    });
  }
  // Ties break on id so a run over the same graph produces the same order twice.
  return activated.sort(
    (left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId),
  );
}

type BatchSelection =
  | { readonly kind: 'batch'; readonly nodeIds: readonly string[] }
  | { readonly kind: 'stop'; readonly termination: ActivationTermination };

/**
 * Algorithm 2 selects the single highest-activation frontier node per step; batching keeps
 * that order — the whole eligible frontier, strongest first — and expands it in one read,
 * because a round-trip per node is what makes the literal algorithm unusable over Bolt.
 */
function selectBatch(state: SpreadState, budget: ActivationBudget): BatchSelection {
  if (state.frontier.size === 0) {
    return { kind: 'stop', termination: 'frontier_exhausted' };
  }

  const eligible = [...state.frontier]
    .filter((nodeId) => (state.scores.get(nodeId) ?? 0) >= budget.minActivation)
    .sort((left, right) => (state.scores.get(right) ?? 0) - (state.scores.get(left) ?? 0));
  if (eligible.length === 0) {
    return { kind: 'stop', termination: 'below_min_activation' };
  }

  const expandable = eligible.filter((nodeId) => (state.hops.get(nodeId) ?? 0) < budget.maxHops);
  if (expandable.length === 0) {
    return { kind: 'stop', termination: 'hop_limit' };
  }

  const room = budget.maxNodesVisited - state.visited.size;
  return { kind: 'batch', nodeIds: expandable.slice(0, room) };
}

/**
 * Whitepaper §5.4 / Algorithm 2. Seeds start activated, activation spreads outward along
 * weighted edges under exponential decay, and the run stops at the first budget it hits.
 * Superseded nodes traverse like any other, carrying their annotation into the result so
 * fusion can rank them beneath current knowledge without losing the lineage (PRD §5.5).
 *
 * The adjacency fetch is a parameter rather than a driver: this stage is an algorithm, and
 * keeping the graph behind one call is what lets it be tested exhaustively without one.
 */
export async function spreadActivation(
  fetch: AdjacencyFetch,
  input: SpreadActivationInput,
): Promise<ActivationRun> {
  const { budget } = input;
  const state = initialize(input.seeds);

  let iterations = 0;
  let termination: ActivationTermination = 'frontier_exhausted';

  while (true) {
    if (iterations >= budget.maxIterations) {
      termination = 'max_iterations';
      break;
    }
    if (state.visited.size >= budget.maxNodesVisited) {
      termination = 'node_budget';
      break;
    }

    const selection = selectBatch(state, budget);
    if (selection.kind === 'stop') {
      termination = selection.termination;
      break;
    }

    iterations += 1;
    for (const nodeId of selection.nodeIds) {
      state.visited.add(nodeId);
      state.frontier.delete(nodeId);
    }

    const neighbors = await fetch({
      frontier: selection.nodeIds,
      visited: [...state.visited],
    });
    for (const neighbor of neighbors) {
      propagate(state, neighbor, budget);
    }
  }

  return {
    activated: collect(state, budget.minActivation),
    iterations,
    nodesVisited: state.visited.size,
    termination,
  };
}
