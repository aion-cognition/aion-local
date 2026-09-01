import type { Driver } from 'neo4j-driver';

import { COGNITIVE_NODE_LABELS, TEXT_NORM_PROPERTY } from './cognitive-queries.js';
import { runRead, type GraphStatement } from './connection.js';
import { upsertEdge, type UpsertedEdge } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import type { RelationshipType } from './relationships.js';

/**
 * Typed edges between entities and cognitive structures, inferred once per episode from the
 * extraction the two prior stages already wrote. This module owns the one read
 * `entity-queries.ts`'s `findEpisodeEntities` does not cover (the cognitive half of the
 * candidate set) and the one write, so the stage never spells either Cypher shape itself.
 */

/**
 * Five semantic relationship types, plus two the catalog already had names for. `SIMILAR_TO`
 * is written under the catalog's existing `SIMILAR`, which is the same relation under the
 * other name: forking a second type would split one claim across two edges and two
 * activation weights. `CONTRADICTS` is its own type: the supersession judgment only compares
 * fact nodes against same-label neighbours and only acts above the auto-apply threshold, so
 * without it nothing in the graph can say that this Decision is in tension with that
 * Insight. `RELATED_TO` and `ANALOGOUS_TO` stay for the connections none of the five name.
 *
 * `satisfies` fails to compile if a name here drifts from the catalog `edges.ts` validates
 * against.
 */
export const SEMANTIC_RELATIONSHIP_TYPES = [
  'CAUSES',
  'ENABLES',
  'PRECEDES',
  'CONTRADICTS',
  'SIMILAR',
  'RELATED_TO',
  'ANALOGOUS_TO',
] as const satisfies readonly RelationshipType[];

export type SemanticRelationshipType = (typeof SEMANTIC_RELATIONSHIP_TYPES)[number];

export function isSemanticRelationshipType(value: string): value is SemanticRelationshipType {
  return (SEMANTIC_RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

/** Appendix B provenance: which pipeline path put the edge in the graph. */
export const SEMANTIC_RELATIONSHIP_METHOD = 'reflection_semantic_relationships';

export type EpisodeCognitiveNode = {
  readonly id: string;
  readonly label: string;
  readonly text: string;
};

function episodeCognitiveNodesStatement(episodeId: string, reference?: Date): GraphStatement {
  const fragment = readModeFragment(withCurrency(reference), 'n');
  return {
    cypher: [
      'MATCH (:Episode { id: $episodeId })<-[:EXTRACTED_FROM]-(n)',
      `WHERE any(label IN labels(n) WHERE label IN $labels) AND ${fragment.where}`,
      'RETURN n.id AS id, [label IN labels(n) WHERE label IN $labels][0] AS label,',
      `       n.${MEMORY_PROPERTIES.text} AS text`,
      `ORDER BY n.${TEXT_NORM_PROPERTY}, n.id`,
    ].join('\n'),
    parameters: { episodeId, labels: [...COGNITIVE_NODE_LABELS], ...fragment.parameters },
  };
}

/**
 * The cognitive half of this stage's candidate set; `findEpisodeEntities` (entity-
 * queries.ts) covers the entity half. Returns `[]` exactly when cognitive extraction has
 * not run for this episode yet, the same not-assumed-to-have-run contract every stage
 * after extraction follows.
 */
export async function findEpisodeCognitiveNodes(
  driver: Driver,
  episodeId: string,
  /** The clock currency is judged from; the wall clock when a caller holds none. */
  reference?: Date,
): Promise<EpisodeCognitiveNode[]> {
  return runRead(driver, episodeCognitiveNodesStatement(episodeId, reference), (row) => ({
    id: row.id as string,
    label: (row.label as string | null) ?? '',
    text: (row.text as string | null) ?? '',
  }));
}

export type SemanticRelationshipWrite = {
  readonly type: SemanticRelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  /** Both the edge's strength and its confidence: the model gives one clamped 0-1 certainty. */
  readonly confidence: number;
  readonly rationale?: string;
  readonly now: Date;
};

/**
 * `count: 0`: one proposal is a single inferred claim, not an observation to tally on
 * replay. A claim repeated across episodes strengthening is reflection reinforcement's job
 * (`reinforcement_queue`), a separate mechanism. This edge's own count staying at zero is
 * what keeps a same-episode re-run (the orchestrator's crash-before-ledger-mark case) a
 * total no-op beyond `updated_at` and the merge policy's max(strength, confidence).
 */
export async function writeSemanticRelationship(
  driver: Driver,
  input: SemanticRelationshipWrite,
): Promise<UpsertedEdge> {
  return upsertEdge(driver, {
    type: input.type,
    sourceId: input.sourceId,
    targetId: input.targetId,
    strength: input.confidence,
    confidence: input.confidence,
    signals: ['reflection'],
    provenance: [SEMANTIC_RELATIONSHIP_METHOD],
    count: 0,
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    now: input.now,
  });
}
