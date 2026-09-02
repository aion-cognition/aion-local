import type { RelationshipType } from '../../infrastructure/graph/relationships.js';

/**
 * Per-relationship-type propagation tuning for spreading activation, split out on its own
 * because the table and its accompanying constants are data, not algorithm.
 */

/**
 * The semantic-relationships stage's five output types. An audit of its live output found
 * the large majority of CONTRADICTS edges wrong and causal direction inverted on episodes
 * that stated it explicitly, with confidence always the same constant regardless, so
 * confidence cannot stand in for a precision discount. `MODEL_INFERRED_PENALTY` below is
 * applied to exactly these five once, at load, so a wrong edge moves a smaller share of a
 * seed's relevance until a quality harness measures the stage's precision and clears them.
 */
export const MODEL_INFERRED_TYPES: readonly RelationshipType[] = [
  'CAUSES',
  'ENABLES',
  'PRECEDES',
  'CONTRADICTS',
  'SIMILAR',
];

/** The discount `MODEL_INFERRED_TYPES` carries until the harness clears them. */
export const MODEL_INFERRED_PENALTY = 0.5;

/**
 * Tuned propagation multipliers per relationship type, all in [0,1]. The tiers below are
 * the tuning: a type's multiplier says how much of a node's relevance its neighbour
 * inherits, so containment and provenance (where the neighbour is literally part of the
 * same experience) sit high, mention and semantic association sit in the middle, and
 * lineage sits low. Typed against the catalog so a new relationship type fails to compile
 * until it is given a weight rather than silently defaulting.
 */
export const ACTIVATION_WEIGHTS: Record<RelationshipType, number> = {
  // Containment. A turn is part of its episode and an episode part of its session, so
  // relevance transfers almost intact; these are most of the edges the graph holds.
  PARTICIPATES_IN: 0.9,
  INCLUDES_EVENT: 0.9,
  BELONGS_TO: 0.7,

  // Provenance and compression. A narrative and its evidence are two views of one thing,
  // and traversal between them is how a summary reaches the episodes behind it.
  SUMMARIZED_BY: 0.9,
  DERIVES_FROM: 0.8,
  EVIDENCES: 0.8,
  EXTRACTED_FROM: 0.8,

  // Temporal chains. FOLLOWS is the cross-session path and the only way a query about today
  // reaches last week's work, so it stays high; PRECEDES is a weaker ordering claim between
  // arbitrary nodes, and model-inferred on top of that (tuned value; MODEL_INFERRED_PENALTY
  // discounts it below).
  FOLLOWS: 0.8,
  PRECEDES: 0.6,

  // Structural backbone. Every session hangs off the same member and workspace, so these
  // edges are the graph's connectivity guarantee and its worst hubs at once: held high
  // enough to bridge sessions, and left to hub inhibition to keep from flooding.
  WITHIN_WORKSPACE: 0.7,
  INITIATED_BY: 0.7,
  HAS_WORKSPACE: 0.7,
  HAS_MEMBER: 0.7,

  // Causal and cognitive structure. A cause carries more of its effect's relevance than a
  // mere requirement or example does. CAUSES and ENABLES are also model-inferred (tuned
  // values; MODEL_INFERRED_PENALTY discounts them below); BASED_ON, REQUIRES, and
  // EXEMPLIFIES are not this stage's output and keep their un-audited weights.
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
  // scaled by strength x confidence (see CONFIDENCE_SCALED_TYPES), so these are ceilings
  // rather than fixed weights; CO_OCCURS and ANALOGOUS_TO are weaker claims still. SIMILAR
  // is also model-inferred (tuned value; MODEL_INFERRED_PENALTY discounts it below);
  // RELATED_TO carries the same provenance but has not been re-audited.
  SIMILAR: 0.6,
  RELATED_TO: 0.5,
  CO_OCCURS: 0.5,
  ANALOGOUS_TO: 0.45,

  // Tension, which is the one semantic type a query almost always wants both ends of: a
  // claim and what argues against it are read together or the pack is misleading. Held at
  // the causal tier for that reason, above every other inferred link (tuned value;
  // MODEL_INFERRED_PENALTY discounts it below).
  CONTRADICTS: 0.7,

  // Lineage. A superseded node is reachable from its replacement, which is what makes the
  // old truth recallable, but the path is deliberately weak, and the node at the far end is
  // down-weighted again by SUPERSEDED_ACTIVATION_WEIGHT.
  SUPERSEDES: 0.4,
};

for (const type of MODEL_INFERRED_TYPES) {
  ACTIVATION_WEIGHTS[type] *= MODEL_INFERRED_PENALTY;
}

/** A type outside the catalog can only come from a writer outside this codebase. */
export const DEFAULT_ACTIVATION_WEIGHT = 0.3;

/**
 * These two are inferred rather than observed, so the confidence behind them scales their
 * propagation on top of the strength scaling every type gets.
 */
export const CONFIDENCE_SCALED_TYPES: readonly string[] = ['SIMILAR', 'RELATED_TO'];
