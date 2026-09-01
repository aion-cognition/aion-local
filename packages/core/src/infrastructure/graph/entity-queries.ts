import type { Driver } from 'neo4j-driver';

import {
  BITEMPORAL_PROPERTIES,
  CLOSURE_PROVENANCE_PROPERTY,
  currentOnly,
  stampNew,
} from './bitemporal.js';
import { inWriteTransaction, runWrite, type GraphStatement } from './connection.js';
import {
  aliasKeys,
  aliasRecord,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
  ENTITY_TYPE_COUNTS_PROPERTY,
  ENTITY_TYPE_PROPERTY,
  observedTypes,
  reconcileMergedEntities,
  type EntityMergeRow,
  type EntityReading,
  type MergedEntity,
} from './entity-identity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, ENTITY_LABEL, resolveLabels } from './labels.js';
import { LOCK_PROPERTY } from './locks.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_ALIASES_PROPERTY,
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  STRUCTURAL_PROPERTY,
} from './seed-queries.js';
import {
  identityRow,
  toGraphDateTime,
  toGraphParameters,
  toGraphVector,
  type GraphProperties,
  type Row,
} from './values.js';
import {
  recordTypeObservations,
  serializeTypeCounts,
  squashName,
} from '../../reflection/domain/entity-reconciliation.js';
import type { Vector } from '../providers/types.js';

/**
 * The writes that turn an extraction into canonical Entity nodes and the two vectors those
 * nodes carry.
 *
 * Canonicalization keys on `name_norm` rather than on an id, because the identity an
 * extraction produces is the name: the id is this run's proposal, and it survives only when
 * nothing already answers to that name. Migration 003's `entity_name_unique` constraint is
 * what makes the MERGE a seek and what keeps two concurrent runs from forking one identity.
 *
 * The type is not part of that key. The extractor is unstable in the label it picks, and
 * keying on the pair made one referent fork into as many nodes as the model had moods. What
 * the label follows instead is counted evidence: every reading lands in `type_counts` and
 * `entity-identity-queries.ts` decides which one the node wears.
 */

/** The names other modules have always imported from here; they are declared with their queries now. */
export {
  addEntityAliases,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
  ENTITY_TYPE_COUNTS_PROPERTY,
  ENTITY_TYPE_PROPERTY,
  findEntityNameForms,
  findSpeakerEntity,
  reconcileMergedEntities,
  type EntityAliasEntry,
  type EntityIdentityMatch,
  type EntityIdentityUpdate,
  type EntityMergeRow,
  type MergedEntity,
} from './entity-identity-queries.js';
export {
  ENTITY_MENTION_TYPE,
  ENTITY_PARTICIPATION_TYPE,
  findEpisodeEntities,
  linkEntityMentions,
  type EntityMentionInput,
  type EpisodeEntity,
} from './entity-mention-queries.js';
export { ENTITY_ALIASES_NORM_PROPERTY, ENTITY_ALIASES_PROPERTY } from './seed-queries.js';

/** Companions are applied on both MERGE branches, so an entity written before a label rule picks it up. */
function companionLabels(): string {
  return resolveLabels(ENTITY_LABEL)
    .filter((label) => label !== ENTITY_LABEL)
    .join(':');
}

/** Confidence score, written once by whichever run created the node. */
const ENTITY_CONFIDENCE_PROPERTY = 'confidence';

export type EntityMergeInput = EntityReading & {
  readonly name: string;
  /** The node's body: what `content_fts` indexes and what its content vector is an embedding of. */
  readonly text: string;
  readonly sourceEpisodeId: string;
  readonly extractionMethod: string;
  readonly confidence: number;
  readonly occurredAt?: Date;
};

/** Property naming stays in this module, so a stage never spells a graph property itself. */
function entityCreateProperties(entity: EntityMergeInput): GraphProperties {
  const aliases = aliasRecord(entity.aliases ?? [], entity.nameNorm);
  return {
    [ENTITY_NAME_PROPERTY]: entity.name,
    [ENTITY_NAME_NORM_PROPERTY]: entity.nameNorm,
    [ENTITY_NAME_SQUASH_PROPERTY]: squashName(entity.nameNorm),
    [ENTITY_TYPE_PROPERTY]: entity.type,
    [ENTITY_TYPE_COUNTS_PROPERTY]: serializeTypeCounts(
      recordTypeObservations({}, observedTypes(entity)),
    ),
    [ENTITY_ALIASES_PROPERTY]: aliases,
    [ENTITY_ALIASES_NORM_PROPERTY]: aliasKeys(aliases, entity.nameNorm),
    [MEMORY_PROPERTIES.text]: entity.text,
    [MEMORY_PROPERTIES.sourceEpisodeId]: entity.sourceEpisodeId,
    [MEMORY_PROPERTIES.extractionMethod]: entity.extractionMethod,
    [ENTITY_CONFIDENCE_PROPERTY]: entity.confidence,
  };
}

/**
 * How far a merge chain is followed to reach the identity that answers today. A depth this
 * side of unbounded keeps one pathological chain from turning a MERGE into a graph walk;
 * eight consecutive merges of one name is already beyond anything dedup produces.
 */
const MERGE_CHAIN_DEPTH = 8;

export type PreparedEntityMerge = {
  readonly statement: GraphStatement;
  /** Per input, in order: the id this run proposed, which is how a returned row pairs back to it. */
  readonly proposedIds: readonly string[];
};

/**
 * One statement for the whole extraction. `ON CREATE` writes the bitemporal stamp and
 * never rewrites it on a match: an entity already in the graph is the same entity, and a
 * changed fact about it is a supersession rather than an overwrite. `created` is read off
 * the id rather than off a counter, since the batch's counters cannot say which row made a
 * node.
 *
 * The MERGE cannot carry a currency predicate: `entity_name_unique` is declared on
 * `name_norm` alone, so a node dedup closed still owns that key and a MERGE restricted to
 * current nodes would violate the constraint rather than miss it. The chain walk after the
 * MERGE is what makes the merge stick: a surface form a previous run merged away resolves
 * forward to the canonical identity, so a later episode naming "PostgreSQL" reaches the
 * "Postgres" node instead of reviving the closed duplicate and re-forking an identity dedup
 * already collapsed.
 *
 * `ON MATCH` also reopens a node a maintenance close marked with `CLOSURE_PROVENANCE_PROPERTY`
 * (`bitemporal.ts`): the mention landing here is the next real signal that close was always
 * betting on, so the node returns to fully current, `closed_by` and all, and the mention edge
 * and companion labels below apply to it exactly as they would to a node that was never closed.
 * A node closed without that marker, human forget or a supersession absorb, keeps its stamps:
 * `aion forget` is a person's choice a mention must never override, and an absorbed duplicate's
 * canonical identity is the node the chain walk below resolves to, not this one.
 *
 * The lock write on the resolved node is what makes the reconciliation that follows safe. The
 * MERGE locks whatever it created or matched, but a chain walk lands on a node this statement
 * never wrote, and a type count read without that lock is a lost update the next extraction
 * cannot notice (`locks.ts`).
 */
export function prepareEntityMerge(
  entities: readonly EntityMergeInput[],
  now: Date,
): PreparedEntityMerge {
  const companions = companionLabels();
  const reopenCondition =
    `n.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL` +
    ` AND n.${CLOSURE_PROVENANCE_PROPERTY} IS NOT NULL`;
  const onMatch = [
    `n:${companions}`,
    `n.${BITEMPORAL_PROPERTIES.validUntil} = CASE WHEN ${reopenCondition} THEN null` +
      ` ELSE n.${BITEMPORAL_PROPERTIES.validUntil} END`,
    `n.${BITEMPORAL_PROPERTIES.txUntil} = CASE WHEN ${reopenCondition} THEN null` +
      ` ELSE n.${BITEMPORAL_PROPERTIES.txUntil} END`,
    `n.${BITEMPORAL_PROPERTIES.forgottenAt} = CASE WHEN ${reopenCondition} THEN null` +
      ` ELSE n.${BITEMPORAL_PROPERTIES.forgottenAt} END`,
    `n.${CLOSURE_PROVENANCE_PROPERTY} = CASE WHEN ${reopenCondition} THEN null` +
      ` ELSE n.${CLOSURE_PROVENANCE_PROPERTY} END`,
  ];
  const cypher = [
    'UNWIND $entities AS entity',
    `MERGE (n:${ENTITY_LABEL} { ${ENTITY_NAME_NORM_PROPERTY}: entity.name_norm })`,
    `ON CREATE SET n:${companions}, n += entity.properties`,
    `ON MATCH SET ${onMatch.join(', ')}`,
    'WITH entity.name_norm AS name_norm, entity.id AS proposed_id, n',
    `OPTIONAL MATCH (head:${ENTITY_LABEL})-[:${SUPERSEDES_TYPE}*1..${String(MERGE_CHAIN_DEPTH)}]->(n)`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`,
    `  AND ${currentOnly('head')}`,
    'WITH name_norm, proposed_id, n, collect(head)[0] AS head',
    'WITH name_norm, proposed_id, coalesce(head, n) AS resolved',
    `SET resolved.${LOCK_PROPERTY} = $now`,
    'RETURN name_norm, proposed_id, resolved.id AS id,',
    '       resolved.id = proposed_id AS created,',
    `       resolved.${ENTITY_NAME_NORM_PROPERTY} AS canonical_name_norm,`,
    `       resolved.${ENTITY_TYPE_PROPERTY} AS type,`,
    `       resolved.${ENTITY_TYPE_COUNTS_PROPERTY} AS type_counts,`,
    `       coalesce(resolved.${ENTITY_ALIASES_PROPERTY}, []) AS aliases,`,
    `       coalesce(resolved.${STRUCTURAL_PROPERTY}, false) AS is_structural,`,
    `       resolved.${ENTITY_NAME_VECTOR_PROPERTY} IS NOT NULL AS has_name_vec,`,
    `       resolved.${ENTITY_NAME_VECTOR_HASH_PROPERTY} AS name_vec_hash,`,
    `       resolved.${MEMORY_PROPERTIES.contentVector} IS NOT NULL AS has_content_vec`,
  ].join('\n');

  const stamped = entities.map((entity) =>
    stampNew({
      label: ENTITY_LABEL,
      properties: entityCreateProperties(entity),
      ...(entity.occurredAt === undefined ? {} : { occurredAt: entity.occurredAt }),
      now,
    }),
  );

  return {
    statement: {
      cypher,
      parameters: {
        now: toGraphDateTime(now),
        entities: entities.map((entity, index) => ({
          name_norm: entity.nameNorm,
          id: stamped[index]?.id ?? '',
          properties: toGraphParameters(stamped[index]?.properties ?? {}),
        })),
      },
    },
    proposedIds: stamped.map((node) => node.id),
  };
}

/** The statement alone, for callers that only want to read what reaches the graph. */
export function buildEntityMerge(entities: readonly EntityMergeInput[], now: Date): GraphStatement {
  return prepareEntityMerge(entities, now).statement;
}

function mapEntityMergeRow(row: Row): EntityMergeRow {
  const nameVectorHash = row.name_vec_hash;
  return {
    proposedId: row.proposed_id as string,
    nameNorm: row.name_norm as string,
    id: row.id as string,
    created: row.created === true,
    canonicalNameNorm: (row.canonical_name_norm as string | null) ?? '',
    type: (row.type as string | null) ?? '',
    typeCounts: typeof row.type_counts === 'string' ? row.type_counts : '',
    aliases: (row.aliases as string[] | null) ?? [],
    isStructural: row.is_structural === true,
    hasNameVector: row.has_name_vec === true,
    hasContentVector: row.has_content_vec === true,
    ...(typeof nameVectorHash === 'string' ? { nameVectorHash } : {}),
  };
}

const WRITE_ENTITY_IDENTITY = [
  'UNWIND $updates AS update',
  `MATCH (n:${ENTITY_LABEL} { id: update.id })`,
  `SET n.${ENTITY_TYPE_PROPERTY} = update.type,`,
  `    n.${ENTITY_TYPE_COUNTS_PROPERTY} = update.type_counts,`,
  `    n.${ENTITY_NAME_SQUASH_PROPERTY} = update.name_squash,`,
  `    n.${ENTITY_ALIASES_PROPERTY} = update.aliases,`,
  `    n.${ENTITY_ALIASES_NORM_PROPERTY} = update.aliases_norm`,
  'RETURN n.id AS id',
].join('\n');

/**
 * Merge and reconcile in one transaction. The read the reconciliation runs on comes out of the
 * merge statement itself, under the lock that statement took, so no second reader can land
 * between the reading and the label it decides.
 */
export async function mergeEntities(
  driver: Driver,
  entities: readonly EntityMergeInput[],
  now: Date,
): Promise<MergedEntity[]> {
  if (entities.length === 0) {
    return [];
  }

  const prepared = prepareEntityMerge(entities, now);
  return inWriteTransaction(driver, async (tx) => {
    const rows = await tx.run(
      prepared.statement.cypher,
      prepared.statement.parameters,
      mapEntityMergeRow,
    );
    const { merged, updates } = reconcileMergedEntities(entities, prepared.proposedIds, rows);
    if (updates.length > 0) {
      await tx.run(
        WRITE_ENTITY_IDENTITY,
        {
          updates: updates.map((update) => ({
            id: update.id,
            type: update.type,
            type_counts: update.typeCounts,
            name_squash: update.nameSquash,
            aliases: [...update.aliases],
            aliases_norm: [...update.aliasesNorm],
          })),
        },
        identityRow,
      );
    }
    return merged;
  });
}

export type EntityVectorEntry = {
  readonly id: string;
  /** The name-only embedding the entity-resolution seed strategy scans. */
  readonly nameVector?: Vector;
  /** sha256 of the exact text `nameVector` was taken over. */
  readonly nameVectorHash?: string;
  /** The embedding of the node's `text`, which is what `content_vec_idx` covers. */
  readonly contentVector?: Vector;
  readonly contentVectorHash?: string;
};

/**
 * The name vector is replaced whenever one is handed in, because the caller only computes one
 * after finding the stored hash stale: aliases accumulate, the embedded text changes with them,
 * and the old write-if-absent rule meant a name was embedded once and never again, losing
 * nomination recall for exactly the identities that attract duplicates.
 *
 * The content vector keeps the write-if-absent rule. It is a function of `text`, which belongs
 * to whichever run created the node, so a concurrent writer's result is as good as this one's.
 * Its hash travels with it rather than beside it: a hash written over a vector that was not
 * stored would claim the node is in sync with text it never embedded.
 */
const WRITE_ENTITY_VECTORS = [
  'UNWIND $entries AS entry',
  `MATCH (n:${BASE_NODE_LABEL} { id: entry.id })`,
  `WITH n, entry, n.${MEMORY_PROPERTIES.contentVector} IS NULL AS content_missing`,
  `SET n.${ENTITY_NAME_VECTOR_PROPERTY} = coalesce(entry.name_vec, n.${ENTITY_NAME_VECTOR_PROPERTY}),`,
  `    n.${ENTITY_NAME_VECTOR_HASH_PROPERTY} =` +
    ` coalesce(entry.name_vec_hash, n.${ENTITY_NAME_VECTOR_HASH_PROPERTY}),`,
  `    n.${MEMORY_PROPERTIES.contentVector} = CASE WHEN content_missing` +
    ` THEN coalesce(entry.content_vec, n.${MEMORY_PROPERTIES.contentVector})` +
    ` ELSE n.${MEMORY_PROPERTIES.contentVector} END,`,
  `    n.${MEMORY_PROPERTIES.contentVectorHash} = CASE WHEN content_missing` +
    ` AND entry.content_vec IS NOT NULL THEN entry.content_vec_hash` +
    ` ELSE n.${MEMORY_PROPERTIES.contentVectorHash} END`,
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
        name_vec_hash: entry.nameVectorHash ?? null,
        content_vec: entry.contentVector === undefined ? null : toGraphVector(entry.contentVector),
        content_vec_hash: entry.contentVectorHash ?? null,
      })),
    },
    (row) => row.id as string,
  );
}
