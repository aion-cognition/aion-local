import type { Driver } from 'neo4j-driver';

import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { inWriteTransaction, runRead, type GraphStatement } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { ENTITY_TYPE_PROPERTY } from './entity-identity-queries.js';
import { CONTAINMENT_TYPE } from './episodes.js';
import { BASE_NODE_LABEL, ENTITY_LABEL } from './labels.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  LAST_ACCESSED_PROPERTY,
} from './seed-queries.js';
import { toGraphDateTime } from './values.js';

/**
 * The two edges one episode's mentions write, the salience they carry, and the read every
 * later stage starts from.
 */

/**
 * Each extracted entity links to its source episode via a PARTICIPATES_IN relationship.
 * Direction follows this adapter's existing use of the type: member to container, as
 * Turn→Episode and Episode→Session already are, so the entity points at the experience it
 * took part in. It is in the pinned protected set: never pruned, never decayed.
 */
export const ENTITY_PARTICIPATION_TYPE = CONTAINMENT_TYPE;

/**
 * A MENTIONS relationship is created from the episode to the entity. It is the opposite
 * direction from PARTICIPATES_IN by design: one records that the entity belongs to the
 * experience, the other that this episode is evidence of the entity. It is the one of the
 * two that carries an observation count and decays.
 */
export const ENTITY_MENTION_TYPE = 'MENTIONS';

const STRUCTURAL_SIGNALS = ['structural'];
const MENTION_SIGNALS = ['episodic'];

/**
 * Salience signals for mentions. Deliberately not idempotent, exactly like recall's
 * access tracking and the edge merge policy's `count`: each call stands for one episode
 * that mentioned the entity, so a replay of the same run counts twice rather than
 * pretending the mention did not happen. The pipeline's ledger gate is what keeps a
 * re-enqueued job from replaying it.
 */
const RECORD_MENTION_SALIENCE = [
  'UNWIND $ids AS entityId',
  `MATCH (n:${BASE_NODE_LABEL} { id: entityId })`,
  `SET n.${LAST_ACCESSED_PROPERTY} = $now,`,
  `    n.${ACCESS_COUNT_PROPERTY} = coalesce(n.${ACCESS_COUNT_PROPERTY}, 0) + 1`,
].join('\n');

export type EntityMentionInput = {
  readonly episodeId: string;
  readonly entityIds: readonly string[];
  readonly now: Date;
  /** How sure the extraction is that this episode mentions these entities. */
  readonly confidence: number;
  readonly provenance: readonly string[];
};

/**
 * Both edges and the salience bump for one episode, in one transaction: an entity linked to
 * an episode it is not recorded as mentioned by would misreport the salience signals that
 * maintenance reads to decide what to prune.
 *
 * PARTICIPATES_IN carries count 0, so a replay is a total no-op on it; MENTIONS carries 1,
 * which the merge policy sums into the observation count.
 */
export async function linkEntityMentions(
  driver: Driver,
  input: EntityMentionInput,
): Promise<number> {
  const entityIds = [...new Set(input.entityIds)];
  if (entityIds.length === 0) {
    return 0;
  }

  return inWriteTransaction(driver, async (tx) => {
    for (const entityId of entityIds) {
      await upsertEdgeInTransaction(tx, {
        type: ENTITY_PARTICIPATION_TYPE,
        sourceId: entityId,
        targetId: input.episodeId,
        strength: 1,
        confidence: 1,
        signals: STRUCTURAL_SIGNALS,
        provenance: [...input.provenance],
        count: 0,
        now: input.now,
      });
      await upsertEdgeInTransaction(tx, {
        type: ENTITY_MENTION_TYPE,
        sourceId: input.episodeId,
        targetId: entityId,
        strength: 1,
        confidence: input.confidence,
        signals: MENTION_SIGNALS,
        provenance: [...input.provenance],
        count: 1,
        now: input.now,
      });
    }

    await tx.run(
      RECORD_MENTION_SALIENCE,
      { ids: entityIds, now: toGraphDateTime(input.now) },
      () => undefined,
    );

    return entityIds.length;
  });
}

export type EpisodeEntity = {
  readonly id: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly type: string;
};

/**
 * The entities one episode mentions, current only. Every stage after this one takes its
 * input from the graph keyed on the episode rather than from an in-memory handoff, so this
 * is the read deduplication, association inference, and reinforcement start from.
 *
 * Currency-filtered, not merely currency-aware: recall shows a superseded row annotated,
 * but a pipeline stage that pairs, links, or judges one writes the duplication back into
 * the graph as structure, which is the fragmentation that running dedup early is meant to
 * prevent. The mention edge onto the closed node stays; it is the record that this episode
 * named that surface form.
 */
function episodeEntitiesStatement(episodeId: string): GraphStatement {
  const fragment = readModeFragment(withCurrency(), 'n');
  return {
    cypher: [
      `MATCH (:Episode { id: $episodeId })-[:${ENTITY_MENTION_TYPE}]->(n:${ENTITY_LABEL})`,
      `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND ${fragment.where}`,
      `RETURN n.id AS id, n.${ENTITY_NAME_PROPERTY} AS name,`,
      `       n.${ENTITY_NAME_NORM_PROPERTY} AS name_norm, n.${ENTITY_TYPE_PROPERTY} AS type`,
      `ORDER BY n.${ENTITY_NAME_NORM_PROPERTY}, n.id`,
    ].join('\n'),
    parameters: { episodeId, ...fragment.parameters },
  };
}

export async function findEpisodeEntities(
  driver: Driver,
  episodeId: string,
): Promise<EpisodeEntity[]> {
  return runRead(driver, episodeEntitiesStatement(episodeId), (row) => ({
    id: row.id as string,
    name: (row.name as string | null) ?? '',
    nameNorm: (row.name_norm as string | null) ?? '',
    type: (row.type as string | null) ?? '',
  }));
}
