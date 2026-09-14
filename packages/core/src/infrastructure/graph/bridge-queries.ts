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
 * spreading activation has a way across.
 *
 * The statements here are the storage, not the choosing. Which two nodes a bridge joins is the
 * operation's question and a model's answer; this writes whatever pair it is handed, records
 * the cosine between them as a measurement rather than as the reason, and keeps the premises
 * and the inferred flag that say what kind of claim the node is.
 */

/** Written on the bridge's edges, so a repair the loop made is separable from anything learned. */
export const BRIDGE_PROVENANCE = 'introspection';

export const BRIDGE_SIGNAL = 'symbiosis_bridge';

/** The two communities the bridge was built between, kept on the node so a later run can see it. */
export const BRIDGE_SOURCE_COMMUNITY_PROPERTY = 'source_community';
export const BRIDGE_TARGET_COMMUNITY_PROPERTY = 'target_community';
/**
 * The cosine between the endpoints, stored for provenance and read by no query. It is a
 * measurement of the pair that was written rather than the reason it was written: a model-led
 * bridge is free to name two nodes the cosine would not have picked, and this then records how
 * far apart the vectors put them.
 */
export const BRIDGE_SIMILARITY_PROPERTY = 'similarity';

/**
 * What the bridge rests on, and who said so. A bridge is an inference across two
 * neighbourhoods, so the node has to carry the statements it was inferred from and the fact
 * that it is an inference; a reader who cannot tell a proposed relation from a recorded one
 * cannot correct either.
 */
export const BRIDGE_PREMISES_PROPERTY = 'premises';
export const BRIDGE_INFERRED_PROPERTY = 'inferred';
/** Which path wrote it: the model's own proposal, or the deterministic floor under it. */
export const BRIDGE_AUTHOR_PROPERTY = 'authored_by';
/** The model's own compatibility reading, absent on a bridge no model authored. */
export const BRIDGE_COMPATIBILITY_PROPERTY = 'compatibility';

/**
 * What each endpoint contributes to the relation, in the words of whoever proposed it. They sit
 * on the node rather than on the edges because the node already names which endpoint is which,
 * and the edge upsert is a shared write path that nothing else needs a role on.
 */
export const BRIDGE_SOURCE_ROLE_PROPERTY = 'source_role';
export const BRIDGE_TARGET_ROLE_PROPERTY = 'target_role';

/** Who authored a bridge's endpoints and text. */
export type BridgeAuthor = 'model' | 'deterministic';

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

export type PublishedBridge = {
  readonly id: string;
  readonly author: BridgeAuthor;
  /** Absent on a deterministic bridge, since only a model gives one. */
  readonly compatibility?: number;
  /** When the bridge was recorded, for the compatibility-calibration sense's age reading. */
  readonly createdAt: Date;
};

const LIST_PUBLISHED_BRIDGES = [
  'MATCH (b:Bridge)',
  `WHERE ${currentOnly('b')}`,
  `RETURN b.id AS id, coalesce(b.${BRIDGE_AUTHOR_PROPERTY}, 'deterministic') AS author,`,
  `       b.${BRIDGE_COMPATIBILITY_PROPERTY} AS compatibility,`,
  `       b.tx_from AS created_at`,
  'ORDER BY created_at DESC',
  'LIMIT $limit',
].join('\n');

/**
 * Every published bridge that carries a recorded stamp, most recent first, for the
 * compatibility-calibration sense. `author` distinguishes the model's own proposals from the
 * deterministic floor, which is what the sense reports separately rather than as one pooled
 * population. A row with no readable `tx_from` is dropped rather than guessed at: every writer
 * stamps it, so its absence means a shape this reader has never seen, not a young bridge.
 */
export async function listPublishedBridges(
  driver: Driver,
  limit: number,
): Promise<readonly PublishedBridge[]> {
  const rows = await runRead(
    driver,
    LIST_PUBLISHED_BRIDGES,
    { limit: toGraphInteger(limit) },
    (row) => ({
      id: row.id as string,
      author: row.author as BridgeAuthor,
      ...(typeof row.compatibility === 'number' ? { compatibility: row.compatibility } : {}),
      createdAt: row.created_at instanceof Date ? row.created_at : undefined,
    }),
  );
  return rows.filter((row): row is PublishedBridge => row.createdAt instanceof Date);
}

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

/**
 * The cosine between two named nodes, or undefined where either carries no usable vector.
 *
 * The closest-pair search above answers "which two are nearest"; this answers "how near are
 * these two", which is the question once something other than the cosine has chosen the pair.
 * The number is recorded on the bridge and on its edges either way, so a model-chosen relation
 * between two distant nodes is visible as exactly that rather than hidden.
 */
const SIMILARITY_BETWEEN = [
  'MATCH (a:Memory), (b:Memory)',
  `WHERE a.id = $leftId AND b.id = $rightId AND ${currentOnly('a')} AND ${currentOnly('b')}`,
  `  AND a.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `  AND b.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `  AND size(a.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `  AND size(b.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `RETURN ${asCosine(
    `vector.similarity.cosine(a.${MEMORY_PROPERTIES.contentVector}, b.${MEMORY_PROPERTIES.contentVector})`,
  )} AS score`,
].join('\n');

export async function similarityBetween(
  driver: Driver,
  input: { readonly leftId: string; readonly rightId: string; readonly dimension: number },
): Promise<number | undefined> {
  return readFirst(
    driver,
    SIMILARITY_BETWEEN,
    {
      leftId: input.leftId,
      rightId: input.rightId,
      dimension: toGraphInteger(input.dimension),
    },
    (row) => row.score as number,
  );
}

export type BridgeWrite = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceCommunity: number;
  readonly targetCommunity: number;
  /**
   * The cosine between the endpoints, where both carry a usable vector. Recorded and never
   * weighted on: a model-led bridge joins the two nodes a relation runs between, and a cause
   * and its consequence sit far apart in a space that measures how alike two texts read.
   */
  readonly similarity?: number;
  /**
   * What the bridge's two edges are worth, on 0 to 1. The author's own reading of the relation:
   * the model's compatibility where a model proposed it, the cosine where the deterministic
   * floor picked the pair.
   */
  readonly weight: number;
  readonly summary: string;
  readonly rationale: string;
  /** What each endpoint contributes. Empty where the author named none. */
  readonly sourceRole: string;
  readonly targetRole: string;
  /** The statements the relation was inferred from, one per line of evidence. */
  readonly premises: readonly string[];
  readonly author: BridgeAuthor;
  /** The author's own reading of how well the two go together, when it gave one. */
  readonly compatibility?: number;
  readonly vector: Vector;
  readonly now: Date;
};

/** An edge's strength and confidence are both on [0,1], whatever reading was handed in. */
function asProportion(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Node and edges commit together. A bridge without its two edges is a new orphan, and a
 * cleanup pass later in the same loop would be right to treat it as one, so the half state is
 * never observable. `count: 0` on the edges makes a repeated write a total no-op.
 */
export async function writeBridge(driver: Driver, input: BridgeWrite): Promise<string> {
  const weight = asProportion(input.weight);
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
        ...(input.similarity === undefined
          ? {}
          : { [BRIDGE_SIMILARITY_PROPERTY]: input.similarity }),
        [BRIDGE_SOURCE_ROLE_PROPERTY]: input.sourceRole,
        [BRIDGE_TARGET_ROLE_PROPERTY]: input.targetRole,
        [BRIDGE_PREMISES_PROPERTY]: [...input.premises],
        [BRIDGE_AUTHOR_PROPERTY]: input.author,
        // Always true, and written rather than assumed. A bridge is a proposed relation and
        // never an observed one, so a reader that finds this node beside a recorded fact can
        // tell which of the two the substrate was told.
        [BRIDGE_INFERRED_PROPERTY]: true,
        ...(input.compatibility === undefined
          ? {}
          : { [BRIDGE_COMPATIBILITY_PROPERTY]: input.compatibility }),
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
