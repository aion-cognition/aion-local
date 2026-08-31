import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly, supersedeInTransaction } from './bitemporal.js';
import { inWriteTransaction, runRead } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL } from './labels.js';
import { FACT_NODE_LABELS, isFactNodeLabel, type FactNodeLabel } from './supersession-queries.js';
import { fromGraphVector, toGraphInteger, type Row } from './values.js';
import type { Vector } from '../providers/types.js';

/**
 * The graph side of claim-level dedup, mirroring `entity-dedup-queries.ts`'s split: what
 * decides a merge lives in the operation and its judge, this module only reads the candidates
 * a similarity search needs and writes the merge once a pair is judged.
 *
 * The label set is `FACT_NODE_LABELS` (Decision, Insight, Concept, Event), not `:Memory`.
 * `:Memory` is the companion label every node type carries so one vector index can span them
 * all; scanning it for "claims" would also return sessions, episodes, turns, entities, and
 * narratives, none of which this dedup is about. `supersession-queries.ts` already draws this
 * line for the same reason, and this module draws it the same way.
 */

/** Provenance on the `SUPERSEDES` edge closing the newer of a merged pair. */
export const CLAIM_DEDUP_METHOD = 'claim_dedup';

export type RecentClaim = {
  readonly id: string;
  readonly label: FactNodeLabel;
  readonly text: string;
  readonly contentVector: Vector;
  readonly occurredAt: Date;
};

const RECENT_CURRENT_CLAIMS = [
  `MATCH (n:${[...FACT_NODE_LABELS].join('|')})`,
  `WHERE ${currentOnly('n')}`,
  `  AND n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `RETURN n.id AS id, [label IN labels(n) WHERE label IN $labels][0] AS label,`,
  `       n.${MEMORY_PROPERTIES.text} AS text, n.${MEMORY_PROPERTIES.contentVector} AS content_vec,`,
  `       n.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at`,
  `ORDER BY n.${BITEMPORAL_PROPERTIES.occurredAt} DESC, n.id`,
  'LIMIT $limit',
].join('\n');

function mapRecentClaim(row: Row): RecentClaim | undefined {
  const label = (row.label as string | null) ?? '';
  if (!isFactNodeLabel(label)) {
    return undefined;
  }
  const contentVector = fromGraphVector(row.content_vec);
  if (contentVector === undefined) {
    return undefined;
  }
  return {
    id: row.id as string,
    label,
    text: (row.text as string | null) ?? '',
    contentVector,
    occurredAt: row.occurred_at as Date,
  };
}

/**
 * The scan population, newest first: recent duplication is where restated claims actually show
 * up, since two adjacent episodes are what produces them. Bounded at `limit`, which the
 * operation sets from its batch knob so one tick's read stays proportional to what it can
 * afford to judge.
 */
export async function findRecentCurrentClaims(
  driver: Driver,
  limit: number,
): Promise<RecentClaim[]> {
  if (limit <= 0) {
    return [];
  }
  const rows = await runRead(
    driver,
    {
      cypher: RECENT_CURRENT_CLAIMS,
      parameters: { labels: [...FACT_NODE_LABELS], limit: toGraphInteger(limit) },
    },
    mapRecentClaim,
  );
  return rows.filter((row): row is RecentClaim => row !== undefined);
}

export type ClaimDedupDetail = {
  readonly id: string;
  readonly occurredAt: Date;
  /** Read again immediately before a merge writes, so a pair judged against a currency reading
   * that has since changed (a concurrent close, or the other half of this same run) is caught
   * as stale rather than merged on stale evidence. */
  readonly current: boolean;
};

const LOAD_CLAIM_DEDUP_DETAILS = [
  'UNWIND $ids AS wantedId',
  `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
  `RETURN n.id AS id, n.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at,`,
  `       ${currentOnly('n')} AS current`,
].join('\n');

function mapClaimDedupDetail(row: Row): ClaimDedupDetail {
  return {
    id: row.id as string,
    occurredAt: row.occurred_at as Date,
    current: row.current === true,
  };
}

/** Batch hydration for the two sides of a pair, read once right before the pair is judged final. */
export async function loadClaimDedupDetails(
  driver: Driver,
  ids: readonly string[],
): Promise<ClaimDedupDetail[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return runRead(
    driver,
    { cypher: LOAD_CLAIM_DEDUP_DETAILS, parameters: { ids: unique } },
    mapClaimDedupDetail,
  );
}

const CLAIM_EPISODES = [
  `MATCH (n:${BASE_NODE_LABEL} { id: $id })-[:EXTRACTED_FROM]->(e:Episode)`,
  'RETURN DISTINCT e.id AS id',
].join('\n');

export type MergeClaimPairInput = {
  readonly survivorId: string;
  readonly loserId: string;
  readonly now: Date;
};

export type MergeClaimPairResult = {
  readonly episodesFolded: number;
};

/**
 * The merge write: fold the loser's `EXTRACTED_FROM` provenance onto the survivor, then close
 * the loser bitemporally with lineage to the survivor, in one transaction so a crash between
 * the two cannot leave provenance folded onto a survivor that never actually absorbed anything.
 *
 * Unlike an entity absorb, nothing is redirected off the loser: its own edges stay exactly
 * where they are, so `aion unsupersede` (which reopens a `SUPERSEDES` close mode-blind, by
 * matching on the edge and the bitemporal stamps rather than on who wrote them) is a complete
 * undo for a claim merge with no claim-specific machinery of its own. Folding is additive
 * rather than a move, so there is nothing on the survivor's side an undo needs to retract
 * either: the added `EXTRACTED_FROM` edge is true regardless of the merge, since the survivor's
 * text was, in fact, also asserted by the episode the loser came from.
 */
export async function mergeClaimPair(
  driver: Driver,
  input: MergeClaimPairInput,
): Promise<MergeClaimPairResult> {
  return inWriteTransaction(driver, async (tx) => {
    const episodes = await tx.run(CLAIM_EPISODES, { id: input.loserId }, (row) => row.id as string);
    for (const episodeId of episodes) {
      await upsertEdgeInTransaction(tx, {
        type: 'EXTRACTED_FROM',
        sourceId: input.survivorId,
        targetId: episodeId,
        strength: 1,
        confidence: 1,
        signals: [CLAIM_DEDUP_METHOD],
        provenance: [CLAIM_DEDUP_METHOD],
        count: 0,
        now: input.now,
      });
    }

    await supersedeInTransaction(tx, {
      oldId: input.loserId,
      newId: input.survivorId,
      now: input.now,
      signals: [CLAIM_DEDUP_METHOD],
      provenance: [CLAIM_DEDUP_METHOD],
    });

    return { episodesFolded: episodes.length };
  });
}
