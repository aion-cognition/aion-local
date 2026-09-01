import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead, runWrite, type GraphStatement } from './connection.js';
import { ENTITY_LABEL } from './labels.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_ALIASES_PROPERTY,
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  STRUCTURAL_PROPERTY,
} from './seed-queries.js';
import { toGraphInteger, type Row } from './values.js';
import { isEntityType, type EntityType } from '../../reflection/domain/entity-extraction.js';
import {
  parseTypeCounts,
  recordTypeObservations,
  reconcileType,
  serializeTypeCounts,
  squashName,
  type TypeCounts,
} from '../../reflection/domain/entity-reconciliation.js';
import { foldName } from '../providers/unicode-fold.js';

/**
 * How an entity is found by the names it answers to, and what its properties become when a
 * second reading arrives. Identity keys on `name_norm` alone since migration 003, so
 * everything here is about the other forms of one name: the squashed spelling, the aliases,
 * and the counted readings that decide which label the node wears.
 */

export const ENTITY_TYPE_PROPERTY = 'type';

/**
 * Counted type observations, JSON encoded because Neo4j has no map property.
 * `entity-reconciliation.ts` owns the encoding and the rule that reads it.
 */
export const ENTITY_TYPE_COUNTS_PROPERTY = 'type_counts';

/**
 * The separator-stripped second lookup key, indexed by migration 003 and never a uniqueness
 * rule. Stored for the dedup cascade to weigh rather than read by the write path: `re-mark`
 * and `remark` squash together and are two words, so squash equality is evidence for a merge
 * that carries a provenance record and an undo, never a routing decision taken at write.
 */
export const ENTITY_NAME_SQUASH_PROPERTY = 'name_squash';

/** sha256 of the exact text `name_vec` was taken over, so a changed input is detectable. */
export const ENTITY_NAME_VECTOR_HASH_PROPERTY = 'name_vec_hash';

/**
 * How many spellings one identity keeps. `MAX_ENTITY_ALIASES` bounds a single extraction's
 * payload; this bounds what accumulates across every routing and every merge, and the two are
 * different risks. Each stored entry is a lookup key that routes some other identity's
 * mentions onto this node, and each one is a line of the text the name vector is taken over,
 * which has to stay inside the embed budget by construction rather than by luck.
 */
export const MAX_STORED_ENTITY_ALIASES = 24;

/**
 * Distinct and sorted, and never the identity's own name: a name is not an alias of itself.
 * Sorted before the cap so one set of spellings always yields one list, whatever order the
 * callers assembled it in.
 */
export function aliasRecord(aliases: readonly string[], nameNorm: string): string[] {
  const kept = new Set<string>();
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (trimmed.length > 0 && foldName(trimmed) !== nameNorm) {
      kept.add(trimmed);
    }
  }
  return [...kept].sort().slice(0, MAX_STORED_ENTITY_ALIASES);
}

/** The lookup keys behind an alias record, under the same cap: one key per spelling kept. */
export function aliasKeys(aliases: readonly string[], nameNorm: string): string[] {
  const keys = new Set<string>();
  for (const alias of aliases) {
    const folded = foldName(alias);
    if (folded.length > 0 && folded !== nameNorm) {
      keys.add(folded);
    }
  }
  return [...keys].sort().slice(0, MAX_STORED_ENTITY_ALIASES);
}

function taxonomyTypes(observed: readonly string[]): EntityType[] {
  return observed.filter((type): type is EntityType => isEntityType(type));
}

/**
 * The incumbent a reconciliation runs against. A node written under an older taxonomy carries
 * a label the rule cannot weigh, so this run's own reading stands in for it; with nothing on
 * the taxonomy to stand in, the stored label is left exactly where it is rather than replaced
 * by a guess.
 */
function reconciledLabel(
  storedType: string,
  observed: readonly string[],
  counts: TypeCounts,
): string {
  if (isEntityType(storedType)) {
    return reconcileType(storedType, counts);
  }
  const proposed = observed.find((type): type is EntityType => isEntityType(type));
  if (proposed === undefined) {
    return storedType;
  }
  return reconcileType(proposed, counts);
}

/** One identity the graph already holds, in the shape every resolution tier reads it. */
export type EntityIdentityMatch = {
  readonly id: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly type: string;
  readonly aliasesNorm: readonly string[];
  readonly isStructural: boolean;
  readonly hasNameVector: boolean;
  /** Absent on a node whose name has never been embedded, and on everything written before 1.8. */
  readonly nameVectorHash?: string;
};

function mapIdentityMatch(row: Row): EntityIdentityMatch {
  const nameVectorHash = row.name_vec_hash;
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? '',
    nameNorm: (row.name_norm as string | null) ?? '',
    type: (row.type as string | null) ?? '',
    aliasesNorm: (row.aliases_norm as string[] | null) ?? [],
    isStructural: row.is_structural === true,
    hasNameVector: row.has_name_vec === true,
    ...(typeof nameVectorHash === 'string' ? { nameVectorHash } : {}),
  };
}

function identityProjection(): string {
  return [
    `n.id AS id, n.${ENTITY_NAME_PROPERTY} AS name`,
    `n.${ENTITY_NAME_NORM_PROPERTY} AS name_norm`,
    `n.${ENTITY_TYPE_PROPERTY} AS type`,
    `coalesce(n.${ENTITY_ALIASES_NORM_PROPERTY}, []) AS aliases_norm`,
    `coalesce(n.${STRUCTURAL_PROPERTY}, false) AS is_structural`,
    `n.${ENTITY_NAME_VECTOR_PROPERTY} IS NOT NULL AS has_name_vec`,
    `n.${ENTITY_NAME_VECTOR_HASH_PROPERTY} AS name_vec_hash`,
  ].join(',\n       ');
}

/** What one resolution read answers: who responds to these names, and which of them are spoken for. */
export type EntityNameForms = {
  /** Current identities answering by their own name or by an alias they have absorbed. */
  readonly forms: readonly EntityIdentityMatch[];
  /** The handed-in names an Entity already keys, whatever that node's currency. */
  readonly ownedNames: ReadonlySet<string>;
};

/**
 * The two halves answer different questions about one read.
 *
 * Routing may only ever land on a current identity, so the alias branch is currency-filtered:
 * a closed node's key is still owned (the constraint spans every Entity whatever its currency)
 * and the MERGE resolves it forward on its own, so returning one there would route an
 * extraction onto an identity dedup already collapsed.
 *
 * Ownership is the opposite reading of the same fact. A name a closed node keys must not be
 * routed anywhere at all: the MERGE is what reopens a node a maintenance close bet against,
 * and a tier answering first would leave that identity split for good, its key held by a node
 * no extraction can reach again.
 *
 * Structural entities are in scope on purpose. Merge-on-collision, read side: a name the
 * backbone already answers to resolves to the Member or the global Workspace instead of
 * forking a second identity under an extracted type. The structural `type` (`member`,
 * `workspace`) is never what an extraction returns, so nothing here may key on type.
 *
 * It returns every holder and decides nothing. A name several identities answer to is exactly
 * the case a caller must not resolve on a coin flip.
 */
function entityNameFormsStatement(names: readonly string[]): GraphStatement {
  return {
    cypher: [
      `MATCH (n:${ENTITY_LABEL})`,
      `WHERE n.${ENTITY_NAME_NORM_PROPERTY} IN $names`,
      `   OR any(alias IN coalesce(n.${ENTITY_ALIASES_NORM_PROPERTY}, [])` +
        ' WHERE alias IN $names)',
      `WITH n, (${currentOnly('n')}) AS is_current`,
      `WHERE is_current OR n.${ENTITY_NAME_NORM_PROPERTY} IN $names`,
      `RETURN ${identityProjection()},`,
      '       is_current',
      'ORDER BY n.id',
    ].join('\n'),
    parameters: { names: [...new Set(names)] },
  };
}

export async function findEntityNameForms(
  driver: Driver,
  names: readonly string[],
): Promise<EntityNameForms> {
  if (names.length === 0) {
    return { forms: [], ownedNames: new Set() };
  }

  const wanted = new Set(names);
  const rows = await runRead(driver, entityNameFormsStatement(names), (row) => ({
    match: mapIdentityMatch(row),
    isCurrent: row.is_current === true,
  }));
  return {
    forms: rows.filter((row) => row.isCurrent).map((row) => row.match),
    ownedNames: new Set(
      rows.map((row) => row.match.nameNorm).filter((nameNorm) => wanted.has(nameNorm)),
    ),
  };
}

/**
 * The backbone Member: who "I" is in every record. Resolved by label rather than by name,
 * because the speaker is the one identity a record refers to without naming, and the name the
 * extraction did give it is a surface form to record on the node, not the key to find it by.
 * Earliest-stamped wins, matching `backbone.ts`'s own singleton resolution.
 */
const FIND_SPEAKER_ENTITY = [
  `MATCH (n:Member:${ENTITY_LABEL})`,
  `WHERE ${currentOnly('n')}`,
  `RETURN ${identityProjection()}`,
  `ORDER BY n.${BITEMPORAL_PROPERTIES.txFrom}, n.id`,
  'LIMIT 1',
].join('\n');

export async function findSpeakerEntity(driver: Driver): Promise<EntityIdentityMatch | undefined> {
  const rows = await runRead(driver, FIND_SPEAKER_ENTITY, {}, mapIdentityMatch);
  return rows[0];
}

export type EntityAliasEntry = {
  readonly id: string;
  /** The holder's own folded name, which is never an alias of itself. */
  readonly nameNorm: string;
  /** Surface forms to record. Already-held aliases are dropped by the statement, not by the caller. */
  readonly aliases: readonly string[];
};

/**
 * Appends surface forms to an identity that is not being merged into: the backbone gaining the
 * name a record called the speaker, an identity gaining the spelling an alias hit routed to it.
 *
 * The union runs in Cypher rather than read-modify-write in application code, so two runs
 * naming the same identity cannot each drop the other's addition. Order is arrival order for
 * the same reason: sorting would need the read this statement exists to avoid. The cap
 * therefore keeps the spellings an identity answered to first, and a full list stops growing
 * rather than displacing them.
 */
const ADD_ENTITY_ALIASES = [
  'UNWIND $entries AS entry',
  `MATCH (n:${ENTITY_LABEL} { id: entry.id })`,
  `WITH n, entry, coalesce(n.${ENTITY_ALIASES_PROPERTY}, []) AS held,`,
  `     coalesce(n.${ENTITY_ALIASES_NORM_PROPERTY}, []) AS held_keys`,
  'WITH n, held + [alias IN entry.aliases WHERE NOT alias IN held] AS merged,',
  '     held_keys + [alias IN entry.aliases_norm WHERE NOT alias IN held_keys] AS merged_keys',
  `SET n.${ENTITY_ALIASES_PROPERTY} = merged[..$max],`,
  `    n.${ENTITY_ALIASES_NORM_PROPERTY} = merged_keys[..$max]`,
  'RETURN n.id AS id',
].join('\n');

export async function addEntityAliases(
  driver: Driver,
  entries: readonly EntityAliasEntry[],
): Promise<string[]> {
  const payload = entries
    .map((entry) => {
      const aliases = aliasRecord(entry.aliases, entry.nameNorm);
      return { id: entry.id, aliases, aliases_norm: aliasKeys(aliases, entry.nameNorm) };
    })
    .filter((entry) => entry.aliases.length > 0 || entry.aliases_norm.length > 0);
  if (payload.length === 0) {
    return [];
  }
  return runWrite(
    driver,
    ADD_ENTITY_ALIASES,
    { entries: payload, max: toGraphInteger(MAX_STORED_ENTITY_ALIASES) },
    (row) => row.id as string,
  );
}

/** What a reconciliation needs from the run that produced a row: its readings and its spellings. */
export type EntityReading = {
  readonly nameNorm: string;
  readonly type: string;
  readonly types?: readonly string[];
  readonly aliases?: readonly string[];
};

/**
 * The readings one run contributes, filtered to the taxonomy. A label the model invented
 * carries no count, so it can never win a reconciliation; the reading itself is simply not
 * evidence of anything the schema knows about.
 */
export function observedTypes(reading: EntityReading): EntityType[] {
  return taxonomyTypes(reading.types ?? [reading.type]);
}

export type MergedEntity = {
  readonly id: string;
  /**
   * Which of the handed-in readings this row answers, so a caller pairs back by position. The
   * name cannot do it: alias routing rewrites two readings onto one holder's key, and a caller
   * keyed on the name would read one row for both and plan its work twice.
   */
  readonly reading: number;
  /** The `name_norm` the caller handed in, which is the key it looks the row back up by. */
  readonly nameNorm: string;
  /** The identity's own folded name, which differs when a merge chain routed this name forward. */
  readonly canonicalNameNorm: string;
  /** The reconciled label, not this extraction's proposal. */
  readonly type: string;
  /** Every lookup key the identity answers to after this run's aliases were folded in. */
  readonly aliasesNorm: readonly string[];
  /** True when this call's proposed id is the one the node kept, which only a creation does. */
  readonly created: boolean;
  readonly hasNameVector: boolean;
  readonly hasContentVector: boolean;
  readonly nameVectorHash?: string;
};

/** One row of the merge statement, before the identity reconciliation applied to it. */
export type EntityMergeRow = {
  readonly proposedId: string;
  readonly nameNorm: string;
  readonly id: string;
  readonly created: boolean;
  readonly canonicalNameNorm: string;
  readonly type: string;
  readonly typeCounts: string;
  readonly aliases: readonly string[];
  readonly isStructural: boolean;
  readonly hasNameVector: boolean;
  readonly hasContentVector: boolean;
  readonly nameVectorHash?: string;
};

/** What the reconciliation decides for one identity, written back inside the merge transaction. */
export type EntityIdentityUpdate = {
  readonly id: string;
  readonly type: string;
  readonly typeCounts: string;
  readonly nameSquash: string;
  readonly aliases: readonly string[];
  readonly aliasesNorm: readonly string[];
};

/**
 * What the ON MATCH branch cannot do in Cypher: weigh this run's readings against the ones the
 * node already carries. The counted map is a JSON string and the taxonomy rule walks it, so the
 * decision is made here and written back inside the same transaction that read it.
 *
 * A row the statement created is excluded from its own delta: `ON CREATE` already recorded that
 * extraction's reading and aliases, and applying them again would count one reading twice.
 * Several readings can land on one identity once alias routing has rewritten their keys, so the
 * deltas are folded per node rather than per reading, or the last write would drop the rest.
 */
export function reconcileMergedEntities(
  readings: readonly EntityReading[],
  proposedIds: readonly string[],
  rows: readonly EntityMergeRow[],
): { readonly merged: MergedEntity[]; readonly updates: EntityIdentityUpdate[] } {
  const byProposedId = new Map(rows.map((row) => [row.proposedId, row]));
  const paired: { reading: number; input: EntityReading; row: EntityMergeRow }[] = [];
  const groups = new Map<
    string,
    { row: EntityMergeRow; observed: EntityType[]; aliases: string[] }
  >();

  for (const [index, input] of readings.entries()) {
    const row = byProposedId.get(proposedIds[index] ?? '');
    if (row === undefined) {
      continue;
    }
    paired.push({ reading: index, input, row });

    let group = groups.get(row.id);
    if (group === undefined) {
      group = { row, observed: [], aliases: [] };
      groups.set(row.id, group);
    }
    if (!row.created) {
      group.observed.push(...observedTypes(input));
      group.aliases.push(...(input.aliases ?? []));
    }
  }

  const updates: EntityIdentityUpdate[] = [];
  const settled = new Map<string, { type: string; aliasesNorm: string[] }>();
  for (const [id, group] of groups) {
    const { row } = group;
    const aliases = aliasRecord([...row.aliases, ...group.aliases], row.canonicalNameNorm);
    const aliasesNorm = aliasKeys(aliases, row.canonicalNameNorm);

    // The backbone keeps its own type and its own identity properties. A mention never
    // relabels it, and `addEntityAliases` is the only thing that writes to it at all.
    if (row.isStructural) {
      settled.set(id, { type: row.type, aliasesNorm: row.aliases.map((alias) => foldName(alias)) });
      continue;
    }

    const counts = recordTypeObservations(parseTypeCounts(row.typeCounts), group.observed);
    const type = reconciledLabel(row.type, group.observed, counts);
    settled.set(id, { type, aliasesNorm });
    updates.push({
      id,
      type,
      typeCounts: serializeTypeCounts(counts),
      nameSquash: squashName(row.canonicalNameNorm),
      aliases,
      aliasesNorm,
    });
  }

  const merged = paired.map(({ reading, input, row }) => {
    const final = settled.get(row.id);
    return {
      id: row.id,
      reading,
      nameNorm: input.nameNorm,
      canonicalNameNorm: row.canonicalNameNorm,
      type: final?.type ?? row.type,
      aliasesNorm: final?.aliasesNorm ?? [],
      created: row.created,
      hasNameVector: row.hasNameVector,
      hasContentVector: row.hasContentVector,
      ...(row.nameVectorHash === undefined ? {} : { nameVectorHash: row.nameVectorHash }),
    };
  });

  return { merged, updates };
}
