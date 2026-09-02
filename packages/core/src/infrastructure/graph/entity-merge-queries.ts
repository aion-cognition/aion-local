import type { Driver } from 'neo4j-driver';

import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import {
  BITEMPORAL_PROPERTIES,
  currentOnly,
  supersedeInTransaction,
  writeStampedNodeInTransaction,
} from './bitemporal.js';
import { forwardClaimSubjectsInTransaction } from './claim-key-queries.js';
import { type GraphTransaction, inWriteTransaction, runWrite } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { aliasPairs, ENTITY_ALIASES_PROPERTY } from './entity-identity-queries.js';
import {
  clearNameVectorHashInTransaction,
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
} from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, ENTITY_LABEL } from './labels.js';
import { lockNodeInTransaction } from './locks.js';
import { isRelationshipType } from './relationships.js';
import { ENTITY_NAME_VECTOR_PROPERTY, LAST_ACCESSED_PROPERTY } from './seed-queries.js';
import type { Row } from './values.js';

/**
 * The write half of an entity merge: redirect an absorbed node's edges onto the canonical,
 * absorb its names and salience, close it with its lineage edge, and record everything an
 * unmerge will need. The reads that find the pair live in `entity-dedup-queries.ts`; who is
 * canonical is decided in `reflection/domain/entity-merge.ts`.
 */

export type RedirectableEdge = {
  readonly mergedId: string;
  /** `elementId(r)` of the relationship as it stood on the merged node, for the unmerge trail. */
  readonly edgeId: string;
  readonly type: string;
  readonly direction: 'out' | 'in';
  readonly otherId: string;
  readonly strength: number;
  readonly confidence: number;
  readonly signals: readonly string[];
  readonly provenance: readonly string[];
  readonly count: number;
  readonly rationale?: string;
};

/**
 * Every relationship touching a node about to be absorbed, whichever direction it runs, on one
 * side of the currency line. `startNode(r).id = mergedId` reads the direction back off the
 * relationship itself rather than issuing two matches, since a merged node's own edges are read
 * exactly once either way.
 */
function findMergedNodeEdges(open: boolean): string {
  return [
    'UNWIND $mergedIds AS mergedId',
    `MATCH (m:${BASE_NODE_LABEL} { id: mergedId })-[r]-(o:${BASE_NODE_LABEL})`,
    `WHERE o.id <> mergedId AND r.${BITEMPORAL_PROPERTIES.validUntil} IS ${open ? '' : 'NOT '}NULL`,
    'RETURN mergedId AS mergedId, elementId(r) AS edgeId, type(r) AS type,',
    "       CASE WHEN startNode(r).id = mergedId THEN 'out' ELSE 'in' END AS direction,",
    '       o.id AS otherId, r.strength AS strength, r.confidence AS confidence,',
    '       r.signals AS signals, r.provenance AS provenance, r.count AS count, r.rationale AS rationale',
  ].join('\n');
}

const FIND_OPEN_MERGED_NODE_EDGES = findMergedNodeEdges(true);

/**
 * The edges `edge_prune` closed on an absorbed node. They are read so the unmerge trail can
 * state them, never so they can be written: `upsertEdgeInTransaction`'s reopen branch would
 * clear both stamps and put every pruned association back on the canonical at floor strength,
 * which is the traversable mass the close measured and removed.
 */
const FIND_CLOSED_MERGED_NODE_EDGES = findMergedNodeEdges(false);

function mapRedirectableEdge(row: Row): RedirectableEdge {
  const { rationale } = row;
  return {
    mergedId: row.mergedId as string,
    edgeId: (row.edgeId as string | null) ?? '',
    type: row.type as string,
    direction: row.direction === 'in' ? 'in' : 'out',
    otherId: row.otherId as string,
    strength: (row.strength as number | null) ?? 0,
    confidence: (row.confidence as number | null) ?? 0,
    signals: (row.signals as string[] | null) ?? [],
    provenance: (row.provenance as string[] | null) ?? [],
    count: (row.count as number | null) ?? 0,
    ...(typeof rationale === 'string' ? { rationale } : {}),
  };
}

async function findMergedNodeEdgesInTransaction(
  tx: GraphTransaction,
  mergedIds: readonly string[],
  cypher: string,
): Promise<RedirectableEdge[]> {
  if (mergedIds.length === 0) {
    return [];
  }
  return tx.run(cypher, { mergedIds: [...mergedIds] }, mapRedirectableEdge);
}

/** The property carrying one JSON record per absorbed identity. Read by the unmerge operation. */
export const MERGE_PROVENANCE_PROPERTY = 'merge_provenance';

/** What the caller knows about an absorbed node that the graph will no longer answer for. */
export type MergedEntityRecord = {
  readonly id: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly type: string;
  readonly aliases: readonly string[];
};

export type MergeEntityGroupInput = {
  readonly canonicalId: string;
  /** The canonical's own folded name, which is the one name its alias keys must not contain. */
  readonly canonicalNameNorm: string;
  readonly mergedIds: readonly string[];
  /**
   * What the absorbed identities contribute, not the final value. The canonical's own side of
   * each of these is read inside the transaction and folded in here, because alias routing and
   * recall's access tracking reach the same node while the caller is deciding, take no lock,
   * and a whole-property write from the caller's snapshot would drop whatever they landed.
   */
  readonly aliases: readonly string[];
  /** Added to what the canonical already carries, so the write is a delta rather than a total. */
  readonly accessCount: number;
  /** Loses to a later stored access time: a merge never moves an identity's access backwards. */
  readonly lastAccessed?: Date;
  /** Carried onto the `SUPERSEDES` edge each merged node gets, so lineage names the merge. */
  readonly supersedeSignals?: readonly string[];
  readonly supersedeProvenance?: readonly string[];
  /**
   * Identity of each absorbed node, keyed by id. A merge is not reversible from the graph
   * alone: `upsertEdgeInTransaction` sums counts and takes the max strength, so once a
   * redirected edge collides with one the canonical already held, nothing on the surviving
   * edge says what the merge contributed. The unmerge operation is maintenance tooling; the
   * record it will need can only be written here, at merge time.
   */
  readonly mergedRecords?: readonly MergedEntityRecord[];
  /** The `entity.merge:` ledger key this merge is idempotent on, stored with the record. */
  readonly ledgerKey?: string;
  /**
   * The idempotency key of the `entity_merge_decisions` row that says why this merge happened.
   * Stored here so an unmerge holds a direct pointer to the evidence rather than recomputing
   * the key from a membership the graph no longer states in one place.
   */
  readonly decisionKey?: string;
  readonly now: Date;
};

export type MergeEntityGroupResult =
  | {
      readonly status: 'applied';
      readonly edgesRedirected: number;
      /** Edges left behind because their stored type is not in the catalog; see the contract below. */
      readonly edgesUnknownType: number;
      readonly superseded: readonly string[];
    }
  | {
      /** A side lost currency between the caller's snapshot and this transaction's locks. */
      readonly status: 'stale';
      readonly staleIds: readonly string[];
    };

/**
 * Of the group's ids, the ones that no longer hold currency. Read after the locks are taken,
 * so the answer is authoritative for the rest of the transaction: a writer that would take a
 * side's currency is blocked on the same lock until this transaction commits.
 */
const FIND_SIDES_WITHOUT_CURRENCY = [
  'UNWIND $ids AS wanted',
  `OPTIONAL MATCH (n:${BASE_NODE_LABEL} { id: wanted })`,
  `WHERE ${currentOnly('n')}`,
  'WITH wanted, n',
  'WHERE n IS NULL',
  'RETURN wanted AS id',
  'ORDER BY id',
].join('\n');

/**
 * One edge as it stood on the absorbed node. `redirected` is false for the edges a merge
 * drops: a relationship whose other endpoint is also in the group becomes a self-loop and is
 * never written. An unmerge has to put those back too, so they are recorded either way.
 */
type ProvenanceEdge = {
  readonly edge_id: string;
  readonly type: string;
  readonly direction: 'out' | 'in';
  readonly other_id: string;
  readonly strength: number;
  readonly confidence: number;
  readonly count: number;
  readonly signals: readonly string[];
  readonly provenance: readonly string[];
  readonly redirected: boolean;
  readonly rationale?: string;
};

function toProvenanceEdge(edge: RedirectableEdge, redirected: boolean): ProvenanceEdge {
  return {
    edge_id: edge.edgeId,
    type: edge.type,
    direction: edge.direction,
    other_id: edge.otherId,
    strength: edge.strength,
    confidence: edge.confidence,
    count: edge.count,
    signals: [...edge.signals],
    provenance: [...edge.provenance],
    redirected,
    ...(edge.rationale === undefined ? {} : { rationale: edge.rationale }),
  };
}

/** The canonical's own side of every property the merge folds a contribution into. */
type CanonicalAbsorbState = {
  readonly records: readonly string[];
  readonly aliases: readonly string[];
  readonly aliasesNorm: readonly string[];
  readonly accessCount: number;
  readonly lastAccessed?: Date;
};

const READ_CANONICAL_ABSORB_STATE = [
  `MATCH (n:${BASE_NODE_LABEL}:${ENTITY_LABEL} { id: $id })`,
  `RETURN coalesce(n.${MERGE_PROVENANCE_PROPERTY}, []) AS records,`,
  `       coalesce(n.${ENTITY_ALIASES_PROPERTY}, []) AS aliases,`,
  `       coalesce(n.${ENTITY_ALIASES_NORM_PROPERTY}, []) AS aliasesNorm,`,
  `       coalesce(n.${ACCESS_COUNT_PROPERTY}, 0) AS accessCount,`,
  `       n.${LAST_ACCESSED_PROPERTY} AS lastAccessed`,
].join('\n');

function storedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Read inside the merge transaction and under its locks, not from the detail load that fed the
 * decision. Every property here is one some other writer moves: `merge_provenance` by a
 * concurrent merge into the same canonical, `aliases` and `aliases_norm` by alias routing,
 * `access_count` and `last_accessed` by recall. None of those writers take this lock, so the
 * read is the only place their work can be seen, and a whole-property write from the caller's
 * snapshot would discard it.
 */
async function readCanonicalAbsorbState(
  tx: GraphTransaction,
  canonicalId: string,
): Promise<CanonicalAbsorbState> {
  const rows = await tx.run(READ_CANONICAL_ABSORB_STATE, { id: canonicalId }, (row) => ({
    records: storedStrings(row.records),
    aliases: storedStrings(row.aliases),
    aliasesNorm: storedStrings(row.aliasesNorm),
    accessCount: (row.accessCount as number | null) ?? 0,
    ...(row.lastAccessed instanceof Date ? { lastAccessed: row.lastAccessed } : {}),
  }));
  return rows[0] ?? { records: [], aliases: [], aliasesNorm: [], accessCount: 0 };
}

/** The later of the two, so absorbing an identity nobody touched recently moves nothing back. */
function latestAccess(stored?: Date, contributed?: Date): Date | undefined {
  if (stored === undefined || contributed === undefined) {
    return stored ?? contributed;
  }
  return stored > contributed ? stored : contributed;
}

/**
 * One JSON string per absorbed identity. Neo4j properties hold no nested maps, so the record
 * is serialized; it is a list rather than one blob so appending a later merge never rewrites
 * an earlier one.
 */
function buildMergeProvenance(
  input: MergeEntityGroupInput,
  mergedIds: readonly string[],
  trail: ReadonlyMap<string, readonly ProvenanceEdge[]>,
  claims: ReadonlyMap<string, readonly string[]>,
): string[] {
  const byId = new Map((input.mergedRecords ?? []).map((record) => [record.id, record]));
  return mergedIds.map((mergedId) => {
    const record = byId.get(mergedId);
    return JSON.stringify({
      merged_id: mergedId,
      merged_at: input.now.toISOString(),
      ...(input.ledgerKey === undefined ? {} : { ledger_key: input.ledgerKey }),
      ...(input.decisionKey === undefined ? {} : { decision_key: input.decisionKey }),
      ...(record === undefined
        ? {}
        : {
            merged_name: record.name,
            merged_name_norm: record.nameNorm,
            merged_type: record.type,
            merged_aliases: [...record.aliases],
          }),
      edges: trail.get(mergedId) ?? [],
      claims: claims.get(mergedId) ?? [],
    });
  });
}

/**
 * The merge runs as one transaction, in this order:
 *
 * 1. Lock the whole group in one pass sorted by id. Sorting the canonical in with the members
 *    rather than ahead of them is what makes the order total: two overlapping groups can pick
 *    different canonicals, and canonical-first would have them request the same two nodes in
 *    opposite orders.
 * 2. Confirm under those locks that every side still holds currency. A group whose member
 *    another writer absorbed is reported `stale` and nothing is written for any of it.
 * 3. Read the merged nodes' open relationships and redirect each through the ordinary
 *    edge-upsert, which is what makes a collision with an edge the canonical already holds sum
 *    and max rather than overwrite. An edge whose other endpoint is also in this group,
 *    including a direct canonical/merged edge, is dropped: after the merge both ends are the
 *    same node, and a self-loop records nothing. An edge whose stored type is outside the
 *    relationship catalog is dropped too and counted in `edgesUnknownType`, since the upsert
 *    would refuse it.
 * 4. Read the merged nodes' closed relationships and record them without writing them. A
 *    relationship `edge_prune` closed comes back open at floor strength if it is fed to the
 *    upsert, so a closed edge moves as a record and never as a write.
 * 5. Move the subject key of every claim asserting about an absorbed identity onto the
 *    canonical, and record which claims moved so a split can hand them back.
 * 6. Read the canonical's own aliases, salience and merge records, fold the group's
 *    contribution into what the read returned, and write the union: aliases and keys unioned,
 *    `access_count` a delta on the stored total, `last_accessed` the later of the two.
 * 7. Close each merged node with its lineage edge.
 *
 * Redirect and close belong to the same commit because either alone is an invalid state. A
 * crash between them used to leave the duplicate stripped of every relationship and still
 * marked current: a live-looking entity with no edges, returned by name lookup and by the
 * dedup KNN search alike.
 */
export async function redirectAndAbsorb(
  driver: Driver,
  input: MergeEntityGroupInput,
): Promise<MergeEntityGroupResult> {
  const mergedIds = [...new Set(input.mergedIds)].sort();
  if (mergedIds.length === 0) {
    return { status: 'applied', edgesRedirected: 0, edgesUnknownType: 0, superseded: [] };
  }
  const groupIds = [...new Set([input.canonicalId, ...mergedIds])].sort();
  const absorbed = new Set(groupIds);

  return inWriteTransaction(driver, async (tx) => {
    // Sorted over the whole group rather than canonical-first: two overlapping groups can
    // pick different canonicals, and canonical-first would then have them request the same
    // two nodes in opposite orders. Sorting by id is the one order every caller agrees on.
    for (const id of groupIds) {
      await lockNodeInTransaction(tx, id, input.now);
    }

    // The caller decided this group off a snapshot that may be minutes old; the sibling
    // paths (claim-dedup, supersession-apply) re-read currency just before writing and this
    // path must too. A side another writer absorbed or a person forgot in the meantime
    // makes the whole group's evidence stale, so nothing is written for any of it.
    const staleIds = await tx.run(
      FIND_SIDES_WITHOUT_CURRENCY,
      { ids: groupIds },
      (row) => row.id as string,
    );
    if (staleIds.length > 0) {
      return { status: 'stale', staleIds };
    }

    const edges = await findMergedNodeEdgesInTransaction(
      tx,
      mergedIds,
      FIND_OPEN_MERGED_NODE_EDGES,
    );
    const trail = new Map<string, ProvenanceEdge[]>();
    let redirected = 0;
    let edgesUnknownType = 0;
    for (const edge of edges) {
      const other = absorbed.has(edge.otherId) ? input.canonicalId : edge.otherId;
      const known = isRelationshipType(edge.type);
      const kept = other !== input.canonicalId && known;
      edgesUnknownType += other !== input.canonicalId && !known ? 1 : 0;
      const record = trail.get(edge.mergedId) ?? [];
      record.push(toProvenanceEdge(edge, kept));
      trail.set(edge.mergedId, record);
      if (!kept) {
        continue;
      }

      const sourceId = edge.direction === 'out' ? input.canonicalId : other;
      const targetId = edge.direction === 'out' ? other : input.canonicalId;
      await upsertEdgeInTransaction(tx, {
        type: edge.type,
        sourceId,
        targetId,
        strength: edge.strength,
        confidence: edge.confidence,
        signals: edge.signals,
        provenance: edge.provenance,
        count: edge.count,
        ...(edge.rationale === undefined ? {} : { rationale: edge.rationale }),
        now: input.now,
      });
      redirected += 1;
    }

    // Recorded, never written. An unmerge has to put a closed edge back on the identity it
    // belonged to, and the graph stops answering for that identity once the merge commits.
    const closedEdges = await findMergedNodeEdgesInTransaction(
      tx,
      mergedIds,
      FIND_CLOSED_MERGED_NODE_EDGES,
    );
    for (const edge of closedEdges) {
      const record = trail.get(edge.mergedId) ?? [];
      record.push(toProvenanceEdge(edge, false));
      trail.set(edge.mergedId, record);
    }

    // A claim keys its subject on an entity id, so the merge moves those keys with the
    // identity and records which ones it moved. Nothing else states it: after the commit the
    // claim reads the canonical, and no arithmetic on the graph says where it came from.
    const forwarded = await forwardClaimSubjectsInTransaction(tx, {
      mergedIds,
      canonicalId: input.canonicalId,
    });
    const claims = new Map<string, string[]>();
    for (const claim of forwarded) {
      claims.set(claim.mergedId, [...(claims.get(claim.mergedId) ?? []), claim.claimId]);
    }

    const stored = await readCanonicalAbsorbState(tx, input.canonicalId);
    const provenance = [
      ...stored.records,
      ...buildMergeProvenance(input, mergedIds, trail, claims),
    ];

    // The absorbed names join what the node already answers to and go through the same pairing
    // the write path uses, so the merge cannot push an identity past the stored alias cap that
    // resolution honours. The stored keys join the union in their own right: a key is what
    // routes another identity's mentions here, and dropping one unroutes them silently. A key
    // whose spelling the cap dropped stands in as its own spelling rather than losing the route.
    const aliases = aliasPairs(
      [...stored.aliases, ...stored.aliasesNorm, ...input.aliases],
      input.canonicalNameNorm,
    );
    const lastAccessed = latestAccess(stored.lastAccessed, input.lastAccessed);
    await writeStampedNodeInTransaction(tx, {
      label: ENTITY_LABEL,
      id: input.canonicalId,
      now: input.now,
      mergeProperties: {
        [ENTITY_ALIASES_PROPERTY]: aliases.map((pair) => pair.alias),
        [ENTITY_ALIASES_NORM_PROPERTY]: aliases.map((pair) => pair.key),
        [ACCESS_COUNT_PROPERTY]: stored.accessCount + input.accessCount,
        [MERGE_PROVENANCE_PROPERTY]: provenance,
        ...(lastAccessed === undefined ? {} : { [LAST_ACCESSED_PROPERTY]: lastAccessed }),
      },
    });
    await clearNameVectorHashInTransaction(tx, input.canonicalId);

    const superseded: string[] = [];
    for (const mergedId of mergedIds) {
      const result = await supersedeInTransaction(tx, {
        oldId: mergedId,
        newId: input.canonicalId,
        now: input.now,
        signals: input.supersedeSignals,
        provenance: input.supersedeProvenance,
      });
      superseded.push(result.oldId);
    }

    return { status: 'applied', edgesRedirected: redirected, edgesUnknownType, superseded };
  });
}

const CLEAR_ENTITY_VECTORS = [
  'UNWIND $ids AS id',
  `MATCH (n:${BASE_NODE_LABEL} { id: id })`,
  `SET n.${ENTITY_NAME_VECTOR_PROPERTY} = null, n.${ENTITY_NAME_VECTOR_HASH_PROPERTY} = null,`,
  `    n.${MEMORY_PROPERTIES.contentVector} = null, n.${MEMORY_PROPERTIES.contentVectorHash} = null`,
  'RETURN n.id AS id',
].join('\n');

/**
 * Vector index cleanup runs post-commit with best-effort semantics. A merged node stays
 * queryable (superseded, not deleted), so its vectors are cleared rather than the node:
 * otherwise it would keep answering `entitySimilaritySeeds`, which is currency-aware
 * rather than currency-filtered by design and does not exclude a superseded row on its own.
 */
export async function clearEntityVectors(
  driver: Driver,
  ids: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return runWrite(driver, CLEAR_ENTITY_VECTORS, { ids: unique }, (row) => row.id as string);
}
