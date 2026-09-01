import type { Driver } from 'neo4j-driver';

import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { supersedeInTransaction, writeStampedNodeInTransaction } from './bitemporal.js';
import { type GraphTransaction, inWriteTransaction, runWrite } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { aliasKeys, aliasRecord } from './entity-identity-queries.js';
import {
  clearNameVectorHashInTransaction,
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_ALIASES_PROPERTY,
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
 * unmerge will need. The reads that find the pair live beside this in
 * `entity-dedup-queries.ts`; who is canonical is decided in `reflection/domain/entity-merge.ts`.
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
 * Every relationship touching a node about to be absorbed, whichever direction it runs.
 * `startNode(r).id = mergedId` reads the direction back off the relationship itself rather
 * than issuing two matches, since a merged node's own edges are read exactly once either way.
 */
const FIND_MERGED_NODE_EDGES = [
  'UNWIND $mergedIds AS mergedId',
  `MATCH (m:${BASE_NODE_LABEL} { id: mergedId })-[r]-(o:${BASE_NODE_LABEL})`,
  'WHERE o.id <> mergedId',
  'RETURN mergedId AS mergedId, elementId(r) AS edgeId, type(r) AS type,',
  "       CASE WHEN startNode(r).id = mergedId THEN 'out' ELSE 'in' END AS direction,",
  '       o.id AS otherId, r.strength AS strength, r.confidence AS confidence,',
  '       r.signals AS signals, r.provenance AS provenance, r.count AS count, r.rationale AS rationale',
].join('\n');

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
): Promise<RedirectableEdge[]> {
  if (mergedIds.length === 0) {
    return [];
  }
  return tx.run(FIND_MERGED_NODE_EDGES, { mergedIds: [...mergedIds] }, mapRedirectableEdge);
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
  /** The full, final alias list: this call sets the property, it does not append to it. */
  readonly aliases: readonly string[];
  readonly accessCount: number;
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

export type MergeEntityGroupResult = {
  readonly edgesRedirected: number;
  readonly superseded: readonly string[];
};

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

const READ_MERGE_PROVENANCE = [
  `MATCH (n:${ENTITY_LABEL} { id: $id })`,
  `RETURN coalesce(n.${MERGE_PROVENANCE_PROPERTY}, []) AS records`,
].join('\n');

/**
 * Read inside the merge transaction, not from the detail load that fed the decision: the
 * property is appended to, and a concurrent merge into the same canonical would otherwise
 * overwrite the record it wrote while this one was deciding.
 */
async function readMergeProvenanceInTransaction(
  tx: GraphTransaction,
  canonicalId: string,
): Promise<string[]> {
  const rows = await tx.run(READ_MERGE_PROVENANCE, { id: canonicalId }, (row) => row.records);
  const records = rows[0];
  if (!Array.isArray(records)) {
    return [];
  }
  return records.filter((record): record is string => typeof record === 'string');
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
    });
  });
}

/**
 * The merge executes inside a graph transaction for atomicity, as one transaction: lock
 * canonical and every merged node (stable order, so two concurrent merges cannot deadlock on
 * each other), read the merged nodes' relationships, redirect each through the ordinary
 * edge-upsert (which is what makes a collision with an edge canonical already holds sum and
 * max rather than overwrite), absorb the aliases and salience, and close each merged node
 * with its lineage edge. An edge whose other endpoint is itself part of this group, including
 * a direct canonical/merged edge, is dropped rather than redirected: after the merge both
 * ends are the same node, and a self-loop records nothing.
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
    return { edgesRedirected: 0, superseded: [] };
  }
  const absorbed = new Set([input.canonicalId, ...mergedIds]);

  return inWriteTransaction(driver, async (tx) => {
    await lockNodeInTransaction(tx, input.canonicalId, input.now);
    for (const mergedId of mergedIds) {
      await lockNodeInTransaction(tx, mergedId, input.now);
    }

    const edges = await findMergedNodeEdgesInTransaction(tx, mergedIds);
    const trail = new Map<string, ProvenanceEdge[]>();
    let redirected = 0;
    for (const edge of edges) {
      const other = absorbed.has(edge.otherId) ? input.canonicalId : edge.otherId;
      const kept = other !== input.canonicalId && isRelationshipType(edge.type);
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

    const provenance = [
      ...(await readMergeProvenanceInTransaction(tx, input.canonicalId)),
      ...buildMergeProvenance(input, mergedIds, trail),
    ];

    // The absorbed names go through the same record the write path uses, so the merge cannot
    // push an identity past the stored alias cap that resolution honours.
    const aliases = aliasRecord(input.aliases, input.canonicalNameNorm);
    await writeStampedNodeInTransaction(tx, {
      label: 'Entity',
      id: input.canonicalId,
      now: input.now,
      mergeProperties: {
        [ENTITY_ALIASES_PROPERTY]: aliases,
        [ENTITY_ALIASES_NORM_PROPERTY]: aliasKeys(aliases, input.canonicalNameNorm),
        [ACCESS_COUNT_PROPERTY]: input.accessCount,
        [MERGE_PROVENANCE_PROPERTY]: provenance,
        ...(input.lastAccessed === undefined
          ? {}
          : { [LAST_ACCESSED_PROPERTY]: input.lastAccessed }),
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

    return { edgesRedirected: redirected, superseded };
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
