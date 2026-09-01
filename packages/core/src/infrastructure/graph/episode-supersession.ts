import type { Driver } from 'neo4j-driver';

import {
  BITEMPORAL_PROPERTIES,
  currentOnly,
  supersedeInTransaction,
  type SupersedeResult,
} from './bitemporal.js';
import { inWriteTransaction, runRead, type GraphTransaction } from './connection.js';
import { SUPERSEDES_TYPE } from './relationships.js';

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
  `  AND ${currentOnly('n')}`,
  '  AND NOT EXISTS {',
  '    MATCH (n)-[:EXTRACTED_FROM]->(other:Episode)',
  `    WHERE other.id <> $episodeId AND other.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  '  }',
  'RETURN n.id AS id',
  'ORDER BY n.id',
].join('\n');

/** The replacement recorded against a closed Episode, so a repair pass can find it. */
const SUCCESSOR_OF_EPISODE = [
  `MATCH (next)-[:${SUPERSEDES_TYPE}]->(old:Episode { id: $episodeId })`,
  `WHERE old.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`,
  'RETURN next.id AS id',
  'ORDER BY next.id',
  'LIMIT 1',
].join('\n');

/** The open Episode a derived node was extracted from; the review path needs it to widen a
 * node-level judgment into the episode-level correction that closes the whole family. */
const SOURCE_EPISODE_OF_NODE = [
  'MATCH (n { id: $nodeId })-[:EXTRACTED_FROM]->(e:Episode)',
  `WHERE ${currentOnly('e')}`,
  'RETURN e.id AS id',
  'ORDER BY e.id',
  'LIMIT 1',
].join('\n');

/** `undefined` when the node is an Episode itself, was never extracted, or its source is closed. */
export async function findSourceEpisodeId(
  driver: Driver,
  nodeId: string,
): Promise<string | undefined> {
  const rows = await runRead(driver, SOURCE_EPISODE_OF_NODE, { nodeId }, (row) => row.id as string);
  return rows[0];
}

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
  /**
   * When the correcting experience happened, which is when the closed claims stopped being
   * true. Defaults to `now`.
   */
  readonly validUntil?: Date;
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
  validUntil: Date,
): Promise<EpisodePropagationResult> {
  const derived = await tx.run(
    DERIVED_NODES_OF_CLOSED_EPISODE,
    { episodeId },
    (row) => row.id as string,
  );

  for (const id of derived) {
    // The successor is the episode, not a sibling fact: nothing in the new episode restates
    // the closed claim, and a closed node with no lineage is a state the substrate forbids.
    await supersedeInTransaction(tx, {
      oldId: id,
      newId: supersededBy,
      now,
      validUntil,
      signals: EPISODE_PROPAGATION_SIGNALS,
      provenance: [EPISODE_PROPAGATION_METHOD],
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
  const validUntil = input.validUntil ?? now;
  return inWriteTransaction(driver, async (tx) => {
    const supersession = await supersedeInTransaction(tx, {
      oldId: input.oldId,
      newId: input.newId,
      now,
      validUntil,
      ...(input.signals === undefined ? {} : { signals: input.signals }),
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    });
    const propagation = await closeDerivedFamily(tx, input.oldId, input.newId, now, validUntil);
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
    // A repair carries no world time of its own: the episode closed before this existed, so
    // both timelines on the family it should have taken with it end at the repair.
    return closeDerivedFamily(tx, input.episodeId, supersededBy, now, now);
  });
}
