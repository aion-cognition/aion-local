import type { Driver } from 'neo4j-driver';

import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { currentOnly, writeStampedNodeInTransaction } from './bitemporal.js';
import { COMMUNITY_PROPERTY } from './community-queries.js';
import { inWriteTransaction, readFirst, runRead } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { ENTITY_NAME_PROPERTY } from './seed-queries.js';
import { toGraphInteger, toGraphVector } from './values.js';
import { asCosine } from './vector-indexes.js';
import { vectorInputHash } from '../../reflection/domain/vector-input.js';
import type { Vector } from '../providers/types.js';

/**
 * The symbiosis bridge: one node that joins two neighbourhoods nothing else connects, so
 * spreading activation has a way across. Everything here is deterministic. The similarity
 * that picks the pair is the embedding the substrate already stores, which is the sanctioned
 * machinery for "these two are about the same thing"; no model is asked for a judgment the
 * vectors already carry.
 */

/** Written on the bridge's edges, so a repair the loop made is separable from anything learned. */
export const BRIDGE_PROVENANCE = 'introspection';

export const BRIDGE_SIGNAL = 'symbiosis_bridge';

/** The two communities the bridge was built between, kept on the node so a later run can see it. */
export const BRIDGE_SOURCE_COMMUNITY_PROPERTY = 'source_community';
export const BRIDGE_TARGET_COMMUNITY_PROPERTY = 'target_community';
/**
 * The cosine that picked the endpoints, stored for provenance and read by no query: the same
 * number reaches recall as the strength and confidence on the bridge's two `RELATED_TO` edges.
 */
export const BRIDGE_SIMILARITY_PROPERTY = 'similarity';

/** Enough of an endpoint to name it in the bridge's own text, short enough to stay a label. */
const ENDPOINT_LABEL_LENGTH = 120;

const ENDPOINT_LABEL = (variable: string): string =>
  `left(coalesce(${variable}.${ENTITY_NAME_PROPERTY}, ${variable}.${MEMORY_PROPERTIES.summary},` +
  ` ${variable}.${MEMORY_PROPERTIES.text}, ${variable}.id), ${String(ENDPOINT_LABEL_LENGTH)})`;

const COUNT_BRIDGES_BETWEEN = [
  'MATCH (b:Bridge)',
  `WHERE ${currentOnly('b')}`,
  `  AND ((b.${BRIDGE_SOURCE_COMMUNITY_PROPERTY} = $left AND b.${BRIDGE_TARGET_COMMUNITY_PROPERTY} = $right)`,
  `   OR (b.${BRIDGE_SOURCE_COMMUNITY_PROPERTY} = $right AND b.${BRIDGE_TARGET_COMMUNITY_PROPERTY} = $left))`,
  'RETURN count(b) AS count',
].join('\n');

/** The cheap early exit: a pair already joined needs no second bridge. */
export async function countBridgesBetween(
  driver: Driver,
  left: number,
  right: number,
): Promise<number> {
  const count = await readFirst(
    driver,
    COUNT_BRIDGES_BETWEEN,
    { left: toGraphInteger(left), right: toGraphInteger(right) },
    (row) => row.count as number,
  );
  return count ?? 0;
}

export type CrossCommunityPair = {
  readonly leftId: string;
  readonly leftLabel: string;
  readonly rightId: string;
  readonly rightLabel: string;
  /** True cosine between the two content vectors. */
  readonly similarity: number;
};

export type CrossCommunityPairInput = {
  readonly left: number;
  readonly right: number;
  /** Members of each side the cross product is taken over, which is what bounds the search. */
  readonly candidateLimit: number;
  readonly dimension: number;
};

/**
 * The closest pair across the two communities, by content vector. Each side contributes its
 * most-read members rather than all of them: the cross product is quadratic, and the nodes
 * recall keeps returning are the ones a shortcut is worth building through.
 */
const FIND_CLOSEST_CROSS_COMMUNITY_PAIR = [
  'MATCH (a:Memory)',
  `WHERE ${currentOnly('a')} AND a.${COMMUNITY_PROPERTY} = $left`,
  `  AND a.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `  AND size(a.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `WITH a ORDER BY coalesce(a.${ACCESS_COUNT_PROPERTY}, 0) DESC, a.id LIMIT $candidateLimit`,
  'WITH collect(a) AS lefts',
  'MATCH (b:Memory)',
  `WHERE ${currentOnly('b')} AND b.${COMMUNITY_PROPERTY} = $right`,
  `  AND b.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `  AND size(b.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `WITH lefts, b ORDER BY coalesce(b.${ACCESS_COUNT_PROPERTY}, 0) DESC, b.id LIMIT $candidateLimit`,
  'WITH lefts, collect(b) AS rights',
  'UNWIND lefts AS a',
  'UNWIND rights AS b',
  `WITH a, b, ${asCosine(
    `vector.similarity.cosine(a.${MEMORY_PROPERTIES.contentVector}, b.${MEMORY_PROPERTIES.contentVector})`,
  )} AS score`,
  `RETURN a.id AS left_id, ${ENDPOINT_LABEL('a')} AS left_label,`,
  `       b.id AS right_id, ${ENDPOINT_LABEL('b')} AS right_label, score`,
  'ORDER BY score DESC, left_id, right_id',
  'LIMIT 1',
].join('\n');

export async function findClosestCrossCommunityPair(
  driver: Driver,
  input: CrossCommunityPairInput,
): Promise<CrossCommunityPair | undefined> {
  const rows = await runRead(
    driver,
    FIND_CLOSEST_CROSS_COMMUNITY_PAIR,
    {
      left: toGraphInteger(input.left),
      right: toGraphInteger(input.right),
      candidateLimit: toGraphInteger(input.candidateLimit),
      dimension: toGraphInteger(input.dimension),
    },
    (row) => ({
      leftId: row.left_id as string,
      leftLabel: (row.left_label as string | null) ?? '',
      rightId: row.right_id as string,
      rightLabel: (row.right_label as string | null) ?? '',
      similarity: row.score as number,
    }),
  );
  return rows[0];
}

export type BridgeWrite = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceCommunity: number;
  readonly targetCommunity: number;
  readonly similarity: number;
  readonly summary: string;
  readonly rationale: string;
  readonly vector: Vector;
  readonly now: Date;
};

/** A proportion out of a cosine, since an edge's strength and confidence are both on [0,1]. */
function asProportion(similarity: number): number {
  if (!Number.isFinite(similarity)) {
    return 0;
  }
  return Math.min(1, Math.max(0, similarity));
}

/**
 * Node and edges commit together. A bridge without its two edges is a new orphan, and a
 * cleanup pass later in the same loop would be right to treat it as one, so the half state is
 * never observable. `count: 0` on the edges makes a repeated write a total no-op.
 */
export async function writeBridge(driver: Driver, input: BridgeWrite): Promise<string> {
  const weight = asProportion(input.similarity);
  return inWriteTransaction(driver, async (tx) => {
    const node = await writeStampedNodeInTransaction(tx, {
      label: 'Bridge',
      now: input.now,
      properties: {
        [MEMORY_PROPERTIES.text]: input.summary,
        [MEMORY_PROPERTIES.contentVector]: toGraphVector(input.vector),
        [MEMORY_PROPERTIES.contentVectorHash]: vectorInputHash(input.summary),
        [BRIDGE_SOURCE_COMMUNITY_PROPERTY]: input.sourceCommunity,
        [BRIDGE_TARGET_COMMUNITY_PROPERTY]: input.targetCommunity,
        [BRIDGE_SIMILARITY_PROPERTY]: input.similarity,
      },
    });

    for (const endpointId of [input.sourceId, input.targetId]) {
      await upsertEdgeInTransaction(tx, {
        type: 'RELATED_TO',
        sourceId: node.id,
        targetId: endpointId,
        strength: weight,
        confidence: weight,
        signals: [BRIDGE_SIGNAL],
        provenance: [BRIDGE_PROVENANCE],
        count: 0,
        rationale: input.rationale,
        now: input.now,
      });
    }

    return node.id;
  });
}
