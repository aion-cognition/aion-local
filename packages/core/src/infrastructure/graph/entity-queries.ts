import type { Driver } from 'neo4j-driver';
import type { Vector } from '../providers/types.js';
import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { BITEMPORAL_PROPERTIES, stampNew } from './bitemporal.js';
import { inWriteTransaction, runRead, runWrite, type GraphStatement } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, resolveLabels } from './labels.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  LAST_ACCESSED_PROPERTY,
  STRUCTURAL_PROPERTY,
} from './seed-queries.js';
import { toGraphDateTime, toGraphParameters, toGraphVector, type GraphProperties, type Row } from './values.js';

/**
 * Whitepaper §6.4, §6.9 and §4.2: the writes that turn an extraction into canonical Entity
 * nodes, the edges that tie them to their episode, and the salience those mentions carry.
 *
 * Canonicalization keys on `(name_norm, type)` rather than on an id, because the identity
 * an extraction produces is the name — the id is this run's proposal, and it survives only
 * when nothing already answers to that name. Migration 001's `entity_name_type_unique`
 * constraint is what makes the MERGE a seek and what keeps two concurrent runs from
 * forking one identity.
 */

/** The primary label the composite constraint is declared on. */
const ENTITY_LABEL = 'Entity';

export const ENTITY_TYPE_PROPERTY = 'type';

/**
 * §6.4: "Each extracted entity is linked to its source episode via a PARTICIPATES_IN
 * relationship." Direction follows this adapter's existing use of the type — member to
 * container, as Turn→Episode and Episode→Session already are — so the entity points at the
 * experience it took part in. It is in the pinned protected set: never pruned, never decayed.
 */
export const ENTITY_PARTICIPATION_TYPE = CONTAINMENT_TYPE;

/**
 * §6.9: "a MENTIONS relationship is created from the episode to the entity". It is the
 * opposite direction from PARTICIPATES_IN by design — one records that the entity belongs
 * to the experience, the other that this episode is evidence of the entity — and it is the
 * one of the two that carries an observation count and decays.
 */
export const ENTITY_MENTION_TYPE = 'MENTIONS';

const STRUCTURAL_SIGNALS = ['structural'];
const MENTION_SIGNALS = ['episodic'];

/** Companions are applied on both MERGE branches, so an entity written before a label rule picks it up. */
function companionLabels(): string {
  return resolveLabels(ENTITY_LABEL)
    .filter((label) => label !== ENTITY_LABEL)
    .join(':');
}

export type StructuralEntityMatch = {
  readonly id: string;
  readonly nameNorm: string;
  readonly type: string;
  readonly hasNameVector: boolean;
};

/**
 * §4.2's merge-on-collision, read side: a name the backbone already answers to resolves to
 * the structural node instead of forking a second identity under an extracted type. The
 * match is on the name alone — the structural `type` (`member`, `workspace`) is never what
 * an extraction returns, so keying on the pair would miss every collision the rule exists
 * for.
 */
function structuralEntitiesStatement(): GraphStatement {
  const fragment = readModeFragment(withCurrency(), 'n');
  return {
    cypher: [
      `MATCH (n:${ENTITY_LABEL})`,
      `WHERE n.${ENTITY_NAME_NORM_PROPERTY} IN $names`,
      `  AND n.${STRUCTURAL_PROPERTY} = true`,
      `  AND ${fragment.where}`,
      `RETURN n.id AS id, n.${ENTITY_NAME_NORM_PROPERTY} AS name_norm,`,
      `       n.${ENTITY_TYPE_PROPERTY} AS type,`,
      `       n.${ENTITY_NAME_VECTOR_PROPERTY} IS NOT NULL AS has_name_vec`,
    ].join('\n'),
    parameters: fragment.parameters,
  };
}

export async function findStructuralEntitiesByName(
  driver: Driver,
  names: readonly string[],
): Promise<StructuralEntityMatch[]> {
  if (names.length === 0) {
    return [];
  }
  const statement = structuralEntitiesStatement();
  return runRead(
    driver,
    statement.cypher,
    { ...statement.parameters, names: [...new Set(names)] },
    (row) => ({
      id: row.id as string,
      nameNorm: row.name_norm as string,
      type: String(row.type ?? ''),
      hasNameVector: row.has_name_vec === true,
    }),
  );
}

/** Appendix B's quality dimension, written once by whichever run created the node. */
const ENTITY_CONFIDENCE_PROPERTY = 'confidence';

export type EntityMergeInput = {
  readonly name: string;
  readonly nameNorm: string;
  readonly type: string;
  /** The node's body: what `content_fts` indexes and what its content vector is an embedding of. */
  readonly text: string;
  readonly sourceEpisodeId: string;
  readonly extractionMethod: string;
  readonly confidence: number;
  readonly occurredAt?: Date;
};

/** Property naming stays in this module, so a stage never spells a graph property itself. */
function entityCreateProperties(entity: EntityMergeInput): GraphProperties {
  return {
    [ENTITY_NAME_PROPERTY]: entity.name,
    [ENTITY_NAME_NORM_PROPERTY]: entity.nameNorm,
    [ENTITY_TYPE_PROPERTY]: entity.type,
    [MEMORY_PROPERTIES.text]: entity.text,
    [MEMORY_PROPERTIES.sourceEpisodeId]: entity.sourceEpisodeId,
    [MEMORY_PROPERTIES.extractionMethod]: entity.extractionMethod,
    [ENTITY_CONFIDENCE_PROPERTY]: entity.confidence,
  };
}

export type MergedEntity = {
  readonly id: string;
  readonly nameNorm: string;
  readonly type: string;
  /** True when this call's proposed id is the one the node kept, which only a creation does. */
  readonly created: boolean;
  readonly hasNameVector: boolean;
  readonly hasContentVector: boolean;
};

/**
 * How far a merge chain is followed to reach the identity that answers today. A depth this
 * side of unbounded keeps one pathological chain from turning a MERGE into a graph walk;
 * eight consecutive merges of one name is already beyond anything dedup produces.
 */
const MERGE_CHAIN_DEPTH = 8;

/**
 * One statement for the whole extraction. `ON CREATE` writes the bitemporal stamp and
 * never rewrites it on a match: an entity already in the graph is the same entity, and a
 * changed fact about it is a supersession rather than an overwrite. `created` is read off
 * the id rather than off a counter, since the batch's counters cannot say which row made a
 * node.
 *
 * The MERGE cannot carry a currency predicate — `entity_name_type_unique` is declared on
 * `(name_norm, type)` alone, so a node dedup closed still owns that key and a MERGE
 * restricted to current nodes would violate the constraint rather than miss it. The chain
 * walk after the MERGE is what makes the merge stick: a surface form a previous run merged
 * away resolves forward to the canonical identity, so a later episode naming "PostgreSQL"
 * reaches the "Postgres" node instead of reviving the closed duplicate and re-forking the
 * identity dedup already collapsed (§6.5).
 */
function buildEntityMerge(entities: readonly EntityMergeInput[], now: Date): GraphStatement {
  const companions = companionLabels();
  const cypher = [
    'UNWIND $entities AS entity',
    `MERGE (n:${ENTITY_LABEL} { ${ENTITY_NAME_NORM_PROPERTY}: entity.name_norm,` +
      ` ${ENTITY_TYPE_PROPERTY}: entity.type })`,
    `ON CREATE SET n:${companions}, n += entity.properties`,
    `ON MATCH SET n:${companions}`,
    'WITH entity.name_norm AS name_norm, entity.type AS type, entity.id AS proposed_id, n',
    `OPTIONAL MATCH (head:${ENTITY_LABEL})-[:${SUPERSEDES_TYPE}*1..${String(MERGE_CHAIN_DEPTH)}]->(n)`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`,
    `  AND head.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `  AND head.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
    'WITH name_norm, type, proposed_id, n, collect(head)[0] AS head',
    'WITH name_norm, type, proposed_id, coalesce(head, n) AS resolved',
    'RETURN name_norm, type, resolved.id AS id,',
    '       resolved.id = proposed_id AS created,',
    `       resolved.${ENTITY_NAME_VECTOR_PROPERTY} IS NOT NULL AS has_name_vec,`,
    `       resolved.${MEMORY_PROPERTIES.contentVector} IS NOT NULL AS has_content_vec`,
  ].join('\n');

  const parameters = {
    entities: entities.map((entity) => {
      const stamped = stampNew({
        label: ENTITY_LABEL,
        properties: entityCreateProperties(entity),
        ...(entity.occurredAt === undefined ? {} : { occurredAt: entity.occurredAt }),
        now,
      });
      return {
        name_norm: entity.nameNorm,
        type: entity.type,
        id: stamped.id,
        properties: toGraphParameters(stamped.properties),
      };
    }),
  };

  return { cypher, parameters };
}

function mapMergedEntity(row: Row): MergedEntity {
  return {
    id: row.id as string,
    nameNorm: row.name_norm as string,
    type: row.type as string,
    created: row.created === true,
    hasNameVector: row.has_name_vec === true,
    hasContentVector: row.has_content_vec === true,
  };
}

export async function mergeEntities(
  driver: Driver,
  entities: readonly EntityMergeInput[],
  now: Date,
): Promise<MergedEntity[]> {
  if (entities.length === 0) {
    return [];
  }
  const statement = buildEntityMerge(entities, now);
  return runWrite(driver, statement.cypher, statement.parameters, mapMergedEntity);
}

export type EntityVectorEntry = {
  readonly id: string;
  /** The name-only embedding the entity-resolution seed strategy scans. */
  readonly nameVector?: Vector;
  /** The embedding of the node's `text`, which is what `content_vec_idx` covers. */
  readonly contentVector?: Vector;
};

/**
 * Fills a vector that is absent and never replaces one that is present. Both are functions
 * of text this run did not write — the name and `text` belong to whichever run created the
 * node — so overwriting would spend an embed to store the same floats, and a concurrent
 * writer's result is as good as this one's.
 */
const WRITE_ENTITY_VECTORS = [
  'UNWIND $entries AS entry',
  `MATCH (n:${BASE_NODE_LABEL} { id: entry.id })`,
  `SET n.${ENTITY_NAME_VECTOR_PROPERTY} = coalesce(n.${ENTITY_NAME_VECTOR_PROPERTY}, entry.name_vec),`,
  `    n.${MEMORY_PROPERTIES.contentVector} = coalesce(n.${MEMORY_PROPERTIES.contentVector}, entry.content_vec)`,
  'RETURN n.id AS id',
].join('\n');

export async function writeEntityVectors(
  driver: Driver,
  entries: readonly EntityVectorEntry[],
): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }
  return runWrite(
    driver,
    WRITE_ENTITY_VECTORS,
    {
      entries: entries.map((entry) => ({
        id: entry.id,
        name_vec: entry.nameVector === undefined ? null : toGraphVector(entry.nameVector),
        content_vec: entry.contentVector === undefined ? null : toGraphVector(entry.contentVector),
      })),
    },
    (row) => row.id as string,
  );
}

/**
 * §6.9's salience signals. Deliberately not idempotent, exactly like recall's
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
 * an episode it is not recorded as mentioned by would misreport §6.9's signals to
 * maintenance, which reads them to decide what to prune.
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
 * the graph as structure — which is the fragmentation §6.5 puts dedup early to prevent.
 * The mention edge onto the closed node stays; it is the record that this episode named
 * that surface form.
 */
function episodeEntitiesStatement(): GraphStatement {
  const fragment = readModeFragment(withCurrency(), 'n');
  return {
    cypher: [
      `MATCH (:Episode { id: $episodeId })-[:${ENTITY_MENTION_TYPE}]->(n:${ENTITY_LABEL})`,
      `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND ${fragment.where}`,
      `RETURN n.id AS id, n.${ENTITY_NAME_PROPERTY} AS name,`,
      `       n.${ENTITY_NAME_NORM_PROPERTY} AS name_norm, n.${ENTITY_TYPE_PROPERTY} AS type`,
      `ORDER BY n.${ENTITY_NAME_NORM_PROPERTY}, n.id`,
    ].join('\n'),
    parameters: fragment.parameters,
  };
}

export async function findEpisodeEntities(
  driver: Driver,
  episodeId: string,
): Promise<EpisodeEntity[]> {
  const statement = episodeEntitiesStatement();
  return runRead(driver, statement.cypher, { ...statement.parameters, episodeId }, (row) => ({
    id: row.id as string,
    name: String(row.name ?? ''),
    nameNorm: String(row.name_norm ?? ''),
    type: String(row.type ?? ''),
  }));
}
