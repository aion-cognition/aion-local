import {
  ACTIVATION_WEIGHTS,
  CONFIDENCE_SCALED_TYPES,
  DEFAULT_ACTIVATION_WEIGHT,
} from './activation-weights.js';
import { isTypedAdmissionEdgeType, type TypedInboundEvidence } from './admission.js';
import type { AdjacencyNeighbor } from '../../infrastructure/graph/adjacency.js';
import type { CurrencyAnnotation } from '../../infrastructure/graph/read-modes.js';
import { isRelationshipType } from '../../infrastructure/graph/relationships.js';

export { MODEL_INFERRED_PENALTY, MODEL_INFERRED_TYPES } from './activation-weights.js';

/**
 * Spreading activation over batched adjacency reads. The graph is asked one question per
 * frontier iteration; everything else (weighting, accumulation, inhibition, termination)
 * happens here, where it is testable without a server.
 */

/** Every seed enters the spread at full activation. */
export const SEED_ACTIVATION = 1;

/**
 * Hub inhibition strength in `1 / (1 + alpha * ln(1 + degree - hubThreshold))`. At
 * `alpha = 0.5` a node ten times the threshold's connectivity keeps about a third of the
 * activation it would otherwise absorb: damped, never severed. The penalty is a function
 * of the excess over the threshold, so it is exactly 1.0 at the threshold and has no step.
 */
const HUB_INHIBITION_ALPHA = 0.5;

/**
 * Superseded knowledge is down-ranked, never hidden. Half weight keeps a superseded node in
 * the spread and lets it propagate onward (a current node reachable only through superseded
 * lineage still surfaces) while ranking it under its replacement. A constant rather than a
 * knob: the ranking treatment of lineage is a property of the bitemporal contract, not
 * something an operator tunes per install.
 */
export const SUPERSEDED_ACTIVATION_WEIGHT = 0.5;

const CURRENT: CurrencyAnnotation = { currency: 'current' };

export type ActivationSeed = {
  readonly nodeId: string;
  /** From seed selection's currency-annotated read; absent is treated as current. */
  readonly currency?: CurrencyAnnotation;
  readonly isStructural?: boolean;
};

/**
 * `config.activation`, plus `config.recall.maxHops` and `config.recall.associationStrength`,
 * which bound traversal for the whole recall pipeline rather than for this stage alone, plus
 * `config.contextResonance.activationLimit`, the cap on the set this stage hands downstream.
 */
export type ActivationBudget = {
  readonly maxIterations: number;
  readonly decayFactor: number;
  readonly minActivation: number;
  readonly maxNodesVisited: number;
  readonly hubThreshold: number;
  readonly maxHops: number;
  /**
   * The strength at which an edge stops being an edge at all. It belongs at or below
   * `hebbian.weightFloor`: decay clamps at that floor precisely so a faded path still carries
   * activation when the cue is strong enough, and a cutoff above it severs the whole band the
   * floor was protecting while every operator surface still reads those edges as present.
   * Fading is `edgeWeight`'s business, and it is proportional; this is only the hard bottom.
   */
  readonly associationStrength: number;
  /** The cap on nodes carried out of spreading activation: how much of the spread survives. */
  readonly maxActivated: number;
};

export type ActivatedNode = {
  readonly nodeId: string;
  readonly score: number;
  /** Distance along the strongest contributing path, not the shortest one. */
  readonly hops: number;
  /** `<seed> -[TYPE]-> <node> -[TYPE]-> <node>`; a seed's own summary is its id. */
  readonly pathSummary: string;
  readonly currency: CurrencyAnnotation;
  /** The Member and the global Workspace: traversed, never packed, never reinforced. */
  readonly isStructural: boolean;
  /**
   * The strongest single hop of CONTRADICTS, SUPERSEDES, or CAUSES evidence that reached this
   * node, independent of which path is `pathSummary`'s: a node whose strongest overall route is
   * an ordinary containment hop can still carry typed evidence from a weaker edge that also
   * reached it. Absent when no qualifying edge ever propagated into it. What the typed-admission
   * tier in `admission.ts` reads; every other consumer of `ActivatedNode` is unaffected.
   */
  readonly typedEvidence?: TypedInboundEvidence;
};

/**
 * Why the spread stopped. `hop_limit` is the bound on traversal depth; `frontier_exhausted`
 * is the small-graph case, which is the ordinary one while the graph is still sparse.
 */
export type ActivationTermination =
  'frontier_exhausted' | 'below_min_activation' | 'hop_limit' | 'node_budget' | 'max_iterations';

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
 * Type multiplier, scaled by the edge's own strength, and by confidence as well for the two
 * inferred types. Exported because the fusion stage explains activation scores with it.
 *
 * Strength scales every type, which is what makes a faded pathway fade rather than vanish. An
 * edge the merge policy left unweighted reads back as 1.0 and is unaffected; only an edge
 * something has actively weakened carries less, in proportion to how weak it now is. Decay is
 * the writer that weakens edges, so this is where its floor becomes a real lower bound on
 * influence instead of a number no traversal ever consults.
 */
export function edgeWeight(neighbor: AdjacencyNeighbor): number {
  const base = isRelationshipType(neighbor.relationshipType)
    ? ACTIVATION_WEIGHTS[neighbor.relationshipType]
    : DEFAULT_ACTIVATION_WEIGHT;
  const scaled = base * clampProportion(neighbor.strength);
  if (!CONFIDENCE_SCALED_TYPES.includes(neighbor.relationshipType)) {
    return scaled;
  }
  return scaled * clampProportion(neighbor.confidence);
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
  readonly structural: Set<string>;
  /** The strongest single contribution seen per node; decides which path is reported. */
  readonly strongest: Map<string, number>;
  /** The strongest single typed-edge contribution seen per node, tracked apart from `strongest`. */
  readonly typedEvidence: Map<string, TypedInboundEvidence>;
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
    structural: new Set(),
    strongest: new Map(),
    typedEvidence: new Map(),
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
    if (seed.isStructural === true) {
      state.structural.add(seed.nodeId);
    }
    state.frontier.add(seed.nodeId);
  }

  return state;
}

/**
 * `A_neighbour = A_current * w_edge * d`, hub-inhibited on arrival and halved again when
 * the neighbour is superseded. Contributions add: reaching one node down several paths is
 * evidence reinforcing relevance, not double counting.
 */
function propagate(
  state: SpreadState,
  neighbor: AdjacencyNeighbor,
  budget: ActivationBudget,
): void {
  // The hard bottom, not the fade. An edge under it is treated as absent; everything above it
  // propagates in proportion to its strength through `edgeWeight`.
  //
  // The shipped adjacency read already filters this in Cypher, so a live run never hands this
  // function an edge under the floor. The check stays anyway: this is the algorithm's own
  // contract on whatever `AdjacencyFetch` it is given, not a guarantee about one query's
  // behaviour, and every fixture-driven test in this file exercises it directly against edges
  // a fake fetch hands back unfiltered.
  if (neighbor.strength < budget.associationStrength) {
    return;
  }

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
  if (neighbor.isStructural) {
    state.structural.add(neighbor.nodeId);
  }

  // Tracked apart from `strongest` below: a node's dominant route can be an ordinary
  // containment hop while a weaker CONTRADICTS or CAUSES edge also reaches it, and the
  // typed-admission tier needs that edge's own contribution, not whichever path won overall.
  if (isTypedAdmissionEdgeType(neighbor.relationshipType)) {
    const existingTyped = state.typedEvidence.get(neighbor.nodeId);
    if (existingTyped === undefined || propagated > existingTyped.contribution) {
      state.typedEvidence.set(neighbor.nodeId, {
        edgeType: neighbor.relationshipType,
        contribution: propagated,
      });
    }
  }

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

function collect(state: SpreadState, budget: ActivationBudget): ActivatedNode[] {
  const activated: ActivatedNode[] = [];
  for (const [nodeId, score] of state.scores) {
    if (score < budget.minActivation) {
      continue;
    }
    const typedEvidence = state.typedEvidence.get(nodeId);
    activated.push({
      nodeId,
      score,
      hops: state.hops.get(nodeId) ?? 0,
      pathSummary: state.paths.get(nodeId) ?? nodeId,
      currency: state.currency.get(nodeId) ?? CURRENT,
      isStructural: state.structural.has(nodeId),
      ...(typedEvidence === undefined ? {} : { typedEvidence }),
    });
  }
  // Ties break on id so a run over the same graph produces the same order twice.
  activated.sort(
    (left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId),
  );
  // Cut after the sort, so the cap keeps the strongest of the spread rather than whatever
  // the traversal happened to reach first.
  return activated.slice(0, Math.max(0, budget.maxActivated));
}

type BatchSelection =
  | { readonly kind: 'batch'; readonly nodeIds: readonly string[] }
  | { readonly kind: 'stop'; readonly termination: ActivationTermination };

/**
 * Expanding the single highest-activation frontier node per step costs a round trip per
 * node, which is unusable over Bolt. Batching keeps that order (the whole eligible frontier,
 * strongest first) and expands it in one read.
 */
function selectBatch(state: SpreadState, budget: ActivationBudget): BatchSelection {
  if (state.frontier.size === 0) {
    return { kind: 'stop', termination: 'frontier_exhausted' };
  }

  const eligible = [...state.frontier]
    .filter((nodeId) => (state.scores.get(nodeId) ?? 0) >= budget.minActivation)
    .sort(
      (left, right) =>
        (state.scores.get(right) ?? 0) - (state.scores.get(left) ?? 0) || left.localeCompare(right),
    );
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
 * Restores one-node-at-a-time ordering inside a batch. Expanding one node at a time means
 * that by the time the second-strongest node in a ring propagates, the strongest is already
 * visited and receives nothing back: an edge between two ring peers fires once, in the
 * direction of decreasing activation. Propagating both ways instead would double-count the
 * edge and make the result depend on the order the graph happened to return its rows.
 */
function orderWithinRing(
  neighbors: readonly AdjacencyNeighbor[],
  batch: readonly string[],
): AdjacencyNeighbor[] {
  const position = new Map(batch.map((nodeId, index) => [nodeId, index]));
  const ordered: AdjacencyNeighbor[] = [];

  for (const sourceId of batch) {
    const sourcePosition = position.get(sourceId) ?? 0;
    for (const neighbor of neighbors) {
      if (neighbor.sourceId !== sourceId) {
        continue;
      }
      const neighborPosition = position.get(neighbor.nodeId);
      if (neighborPosition !== undefined && neighborPosition <= sourcePosition) {
        continue;
      }
      ordered.push(neighbor);
    }
  }

  return ordered;
}

/**
 * Seeds start activated, activation spreads outward along weighted edges under exponential
 * decay, and the run stops at the first budget it hits. Superseded nodes traverse like any
 * other, carrying their annotation into the result so fusion can rank them beneath current
 * knowledge without losing the lineage.
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
  let termination: ActivationTermination;

  for (;;) {
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
      ({ termination } = selection);
      break;
    }

    iterations += 1;
    // Captured before the batch joins `visited`: propagation reaches every neighbour not yet
    // visited, and a peer selected in this same batch is still unvisited at the moment
    // one-at-a-time expansion would reach it. Excluding it here would silently discard every
    // edge inside a frontier ring.
    const alreadyExpanded = [...state.visited];
    for (const nodeId of selection.nodeIds) {
      state.visited.add(nodeId);
      state.frontier.delete(nodeId);
    }

    const neighbors = await fetch({
      frontier: selection.nodeIds,
      visited: alreadyExpanded,
    });
    for (const neighbor of orderWithinRing(neighbors, selection.nodeIds)) {
      propagate(state, neighbor, budget);
    }
  }

  return {
    activated: collect(state, budget),
    iterations,
    nodesVisited: state.visited.size,
    termination,
  };
}
