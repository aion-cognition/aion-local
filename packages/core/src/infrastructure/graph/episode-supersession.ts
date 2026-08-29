import type { Driver } from 'neo4j-driver';
import {
  BITEMPORAL_PROPERTIES,
  supersedeInTransaction,
  type SupersedeResult,
} from './bitemporal.js';
import { inWriteTransaction, type GraphTransaction } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { BASE_NODE_LABEL } from './labels.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { toGraphDateTime } from './values.js';

/**
 * Closing an Episode leaves the facts extracted from it open, so recall keeps serving the
 * corrected value as `current` and ranks it above the correction. A family is one superseded
 * episode plus the derived nodes it is the only open source of; the whole family closes in
 * one transaction, because a half-closed family is a substrate that contradicts itself.
 *
 * Entities are out of scope by construction: they hang off `MENTIONS`, not `EXTRACTED_FROM`,
 * and one entity outlives any episode that named it.
 */

/** Appendix B provenance, distinct from a judged contradiction so lineage stays readable. */
export const EPISODE_PROPAGATION_METHOD = 'supersession_episode_propagation';

const EPISODE_PROPAGATION_SIGNALS = ['episode_supersession'];

/**
 * A derived node qualifies only when every episode it was extracted from is closed. A node
 * that still has an open source is a fact the substrate observed somewhere else too.
 */
const DERIVED_NODES_OF_CLOSED_EPISODE = [
  'MATCH (n)-[:EXTRACTED_FROM]->(old:Episode { id: $episodeId })',
  `WHERE old.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`,
  `  AND n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  '  AND NOT EXISTS {',
  '    MATCH (n)-[:EXTRACTED_FROM]->(other:Episode)',
  `    WHERE other.id <> $episodeId AND other.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  '  }',
  'RETURN n.id AS id',
  'ORDER BY n.id',
].join('\n');

const CLOSE_DERIVED_NODE = [
  `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
  `SET n.${BITEMPORAL_PROPERTIES.validUntil} = coalesce(n.${BITEMPORAL_PROPERTIES.validUntil}, $now),`,
  `    n.${BITEMPORAL_PROPERTIES.txUntil} = coalesce(n.${BITEMPORAL_PROPERTIES.txUntil}, $now)`,
  'RETURN n.id AS id',
].join('\n');

/** The replacement recorded against a closed Episode, so a repair pass can find it. */
const SUCCESSOR_OF_EPISODE = [
  `MATCH (next)-[:${SUPERSEDES_TYPE}]->(old:Episode { id: $episodeId })`,
  `WHERE old.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`,
  'RETURN next.id AS id',
  'ORDER BY next.id',
  'LIMIT 1',
].join('\n');

export type EpisodePropagationResult = {
  readonly episodeId: string;
  /** The node the closed facts now point at: the superseding episode. */
  readonly supersededBy: string;
  readonly closedIds: readonly string[];
};

export type SupersedeEpisodeInput = {
  readonly oldId: string;
  readonly newId: string;
  readonly now?: Date;
  readonly signals?: readonly string[];
  readonly provenance?: readonly string[];
};

export type SupersedeEpisodeResult = {
  readonly supersession: SupersedeResult;
  readonly propagation: EpisodePropagationResult;
};

async function closeDerivedFamily(
  tx: GraphTransaction,
  episodeId: string,
  supersededBy: string,
  now: Date,
): Promise<EpisodePropagationResult> {
  const derived = await tx.run(
    DERIVED_NODES_OF_CLOSED_EPISODE,
    { episodeId },
    (row) => row.id as string,
  );

  for (const id of derived) {
    await tx.run(CLOSE_DERIVED_NODE, { id, now: toGraphDateTime(now) }, (row) => row.id as string);
    // The successor is the episode, not a sibling fact: nothing in the new episode restates
    // the closed claim, and a closed node with no lineage is a state the substrate forbids.
    await upsertEdgeInTransaction(tx, {
      type: SUPERSEDES_TYPE,
      sourceId: supersededBy,
      targetId: id,
      strength: 1,
      confidence: 1,
      signals: EPISODE_PROPAGATION_SIGNALS,
      provenance: [EPISODE_PROPAGATION_METHOD],
      count: 0,
      now,
    });
  }

  return { episodeId, supersededBy, closedIds: derived };
}

/**
 * Closes an Episode and its derived family in one transaction. This is the path a correction
 * takes: `supersede()` alone closes the episode and nothing else.
 */
export async function supersedeEpisode(
  driver: Driver,
  input: SupersedeEpisodeInput,
): Promise<SupersedeEpisodeResult> {
  const now = input.now ?? new Date();
  return inWriteTransaction(driver, async (tx) => {
    const supersession = await supersedeInTransaction(tx, {
      oldId: input.oldId,
      newId: input.newId,
      now,
      ...(input.signals === undefined ? {} : { signals: input.signals }),
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    });
    const propagation = await closeDerivedFamily(tx, input.oldId, input.newId, now);
    return { supersession, propagation };
  });
}

/**
 * The same propagation over an episode something else already closed: the repair path for a
 * substrate whose episodes were superseded before this existed. A no-op when the episode is
 * open, carries no lineage, or has nothing left to close.
 */
export async function propagateEpisodeSupersession(
  driver: Driver,
  input: { readonly episodeId: string; readonly now?: Date },
): Promise<EpisodePropagationResult | undefined> {
  const now = input.now ?? new Date();
  return inWriteTransaction(driver, async (tx) => {
    const successors = await tx.run(
      SUCCESSOR_OF_EPISODE,
      { episodeId: input.episodeId },
      (row) => row.id as string,
    );
    const supersededBy = successors[0];
    if (supersededBy === undefined) {
      return undefined;
    }
    return closeDerivedFamily(tx, input.episodeId, supersededBy, now);
  });
}
