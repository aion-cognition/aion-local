import type { Driver } from 'neo4j-driver';

import { currentOnly } from './bitemporal.js';
import { runRead } from './connection.js';
import { ENTITY_ALIASES_NORM_PROPERTY, ENTITY_NAME_SQUASH_PROPERTY } from './entity-queries.js';
import { ENTITY_LABEL } from './labels.js';
import { ENTITY_NAME_NORM_PROPERTY } from './seed-queries.js';
import { toGraphInteger, type Row } from './values.js';

/**
 * The two readings tier 0 of the cascade acts on without asking a model. Both say the same
 * thing in different words: the graph is already holding one name twice, under a spelling the
 * `name_norm` uniqueness key cannot see.
 *
 * Neither read decides anything. They return ids; the caller loads the identities, picks the
 * canonical, and writes the merge with its provenance and its decision record. Currency is
 * filtered here rather than by the caller, because a closed node's key is still owned and a
 * pair with a closed side has nothing left to merge.
 *
 * Scoping is optional and it narrows the answer, not the scan: both arms group over the whole
 * current entity population first and `subjectIds` filters what comes back. The reflection stage
 * passes the episode's own entities, the maintenance sweep passes nothing, and the two cost the
 * same walk.
 */

export type SquashEqualityGroup = {
  /** The shared separator-stripped key, carried so a decision record can name what matched. */
  readonly squash: string;
  /** Every current identity answering to that key, id-sorted. Never fewer than two. */
  readonly ids: readonly string[];
};

export type AliasEqualityPair = {
  /** The identity carrying the alias. */
  readonly holderId: string;
  /** The identity whose own folded name is that alias. */
  readonly ownerId: string;
  readonly aliasKey: string;
};

export type Tier0ScanOptions = {
  /** When present, only groups or pairs touching one of these ids come back. */
  readonly subjectIds?: readonly string[];
  readonly limit: number;
};

/**
 * `name_squash` is indexed by migration 003, so the grouping is an index scan rather than a
 * label scan. A key held by one identity is not a duplicate and never leaves the server.
 */
const FIND_SQUASH_EQUALITY_GROUPS = [
  `MATCH (n:${ENTITY_LABEL})`,
  `WHERE ${currentOnly('n')}`,
  `  AND n.${ENTITY_NAME_SQUASH_PROPERTY} IS NOT NULL AND n.${ENTITY_NAME_SQUASH_PROPERTY} <> ''`,
  `WITH n.${ENTITY_NAME_SQUASH_PROPERTY} AS squash, collect(DISTINCT n.id) AS ids`,
  'WHERE size(ids) > 1',
  '  AND ($subjectIds IS NULL OR any(id IN ids WHERE id IN $subjectIds))',
  'RETURN squash, ids',
  'ORDER BY squash',
  'LIMIT $limit',
].join('\n');

function mapSquashGroup(row: Row): SquashEqualityGroup {
  return {
    squash: row.squash as string,
    ids: [...(row.ids as string[])].sort(),
  };
}

export async function findSquashEqualityGroups(
  driver: Driver,
  options: Tier0ScanOptions,
): Promise<SquashEqualityGroup[]> {
  if (options.limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    FIND_SQUASH_EQUALITY_GROUPS,
    {
      subjectIds: options.subjectIds === undefined ? null : [...options.subjectIds],
      limit: toGraphInteger(options.limit),
    },
    mapSquashGroup,
  );
}

/**
 * An alias is a lookup key that routes some other identity's mentions onto its holder, so an
 * alias matching a live identity's own name says the graph is holding one thing twice. Two
 * identities claiming one alias says nothing of the kind: the key is ambiguous, resolution
 * already refuses to route on it, and this refuses to merge on it. Such a pair still reaches
 * the cascade through nomination, where a judge weighs it.
 *
 * `aliases_norm` carries no index, so the first match is a label scan over current entities.
 * That is the whole of the cost at local scale; the second match is a lookup against the
 * `name_norm` uniqueness constraint. Size this again if the entity population reaches a scale
 * where a full scan per maintenance tick stops being free.
 */
const FIND_ALIAS_EQUALITY_PAIRS = [
  `MATCH (holder:${ENTITY_LABEL})`,
  `WHERE ${currentOnly('holder')} AND size(coalesce(holder.${ENTITY_ALIASES_NORM_PROPERTY}, [])) > 0`,
  `UNWIND holder.${ENTITY_ALIASES_NORM_PROPERTY} AS aliasKey`,
  'WITH aliasKey, collect(DISTINCT holder.id) AS holderIds',
  'WHERE size(holderIds) = 1',
  `MATCH (owner:${ENTITY_LABEL} { ${ENTITY_NAME_NORM_PROPERTY}: aliasKey })`,
  `WHERE ${currentOnly('owner')} AND owner.id <> holderIds[0]`,
  'WITH aliasKey, holderIds[0] AS holderId, owner.id AS ownerId',
  'WHERE $subjectIds IS NULL OR holderId IN $subjectIds OR ownerId IN $subjectIds',
  'RETURN holderId AS holder_id, ownerId AS owner_id, aliasKey AS alias_key',
  'ORDER BY alias_key, holder_id',
  'LIMIT $limit',
].join('\n');

function mapAliasPair(row: Row): AliasEqualityPair {
  return {
    holderId: row.holder_id as string,
    ownerId: row.owner_id as string,
    aliasKey: row.alias_key as string,
  };
}

export async function findAliasEqualityPairs(
  driver: Driver,
  options: Tier0ScanOptions,
): Promise<AliasEqualityPair[]> {
  if (options.limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    FIND_ALIAS_EQUALITY_PAIRS,
    {
      subjectIds: options.subjectIds === undefined ? null : [...options.subjectIds],
      limit: toGraphInteger(options.limit),
    },
    mapAliasPair,
  );
}

/**
 * The same two readings as one number, for the health snapshot that decides whether the
 * graph-wide sweep is worth a tick. Both arms return identities rather than groups and the
 * count is distinct across them, because one identity reachable both ways is still one merge
 * waiting to happen.
 */
const COUNT_TIER0_ELIGIBLE = [
  'CALL () {',
  `  MATCH (n:${ENTITY_LABEL})`,
  `  WHERE ${currentOnly('n')}`,
  `    AND n.${ENTITY_NAME_SQUASH_PROPERTY} IS NOT NULL AND n.${ENTITY_NAME_SQUASH_PROPERTY} <> ''`,
  `  WITH n.${ENTITY_NAME_SQUASH_PROPERTY} AS squash, collect(DISTINCT n.id) AS ids`,
  '  WHERE size(ids) > 1',
  '  UNWIND ids AS id',
  '  RETURN id',
  'UNION',
  `  MATCH (holder:${ENTITY_LABEL})`,
  `  WHERE ${currentOnly('holder')} AND size(coalesce(holder.${ENTITY_ALIASES_NORM_PROPERTY}, [])) > 0`,
  `  UNWIND holder.${ENTITY_ALIASES_NORM_PROPERTY} AS aliasKey`,
  '  WITH aliasKey, collect(DISTINCT holder.id) AS holderIds',
  '  WHERE size(holderIds) = 1',
  `  MATCH (owner:${ENTITY_LABEL} { ${ENTITY_NAME_NORM_PROPERTY}: aliasKey })`,
  `  WHERE ${currentOnly('owner')} AND owner.id <> holderIds[0]`,
  '  UNWIND [holderIds[0], owner.id] AS id',
  '  RETURN id',
  '}',
  'WITH id LIMIT $limit',
  'RETURN count(DISTINCT id) AS eligible',
].join('\n');

/**
 * Identities the deterministic sweep could absorb, capped by the scan limit. A cut read is a
 * floor rather than a total, which is the reading the relevance rule wants either way: past
 * the cap the answer is "there is work here", not a number.
 */
export async function countTier0EligibleEntities(
  driver: Driver,
  options: { readonly limit: number },
): Promise<number> {
  if (options.limit <= 0) {
    return 0;
  }
  const rows = await runRead(
    driver,
    COUNT_TIER0_ELIGIBLE,
    { limit: toGraphInteger(options.limit) },
    (row: Row) => Number(row.eligible),
  );
  return rows[0] ?? 0;
}
