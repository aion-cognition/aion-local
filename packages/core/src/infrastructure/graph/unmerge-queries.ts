import type { Driver } from 'neo4j-driver';

import { ACCESS_COUNT_PROPERTY } from './access-tracking.js';
import { supersedeInTransaction, writeStampedNodeInTransaction } from './bitemporal.js';
import { inWriteTransaction, runRead, type GraphTransaction } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { MERGE_PROVENANCE_PROPERTY } from './entity-dedup-queries.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_ALIASES_PROPERTY,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_TYPE_PROPERTY,
} from './entity-queries.js';
import { BASE_NODE_LABEL } from './labels.js';
import { lockNodeInTransaction } from './locks.js';
import { isRelationshipType } from './relationships.js';
import { ENTITY_NAME_NORM_PROPERTY, ENTITY_NAME_PROPERTY } from './seed-queries.js';
import { squashName } from '../../reflection/domain/entity-reconciliation.js';
import { foldName } from '../providers/unicode-fold.js';

/**
 * Splitting a merged entity back out, from the record the merge wrote at merge time. The
 * graph alone cannot answer this: the merge redirects an absorbed node's edges through the
 * ordinary upsert, which sums counts and takes the max strength, so once a redirected edge
 * lands on one the canonical already held nothing on the survivor says what the merge
 * contributed. `merge_provenance` on the canonical is that missing statement.
 *
 * Nothing here is destructive. The absorbed node stays closed and stays where it is, the
 * canonical keeps every edge it holds, and the split identity comes back as a new node. That
 * is why the protected relationship set is not consulted: an unmerge only adds.
 */

/**
 * The folded lookup half of an alias record. An unmerge has to rewrite it on both sides or the
 * released name keeps answering cues on behalf of the canonical it just left. No name is
 * excluded here: an alias that folds onto the holder's own name is already reachable by the
 * exact-name branch, so a duplicate key changes no answer.
 */
function aliasLookupKeys(aliases: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const alias of aliases) {
    const folded = foldName(alias);
    if (folded.length > 0) {
      keys.add(folded);
    }
  }
  return [...keys].sort();
}

export type MergeProvenanceEdge = {
  readonly type: string;
  readonly direction: 'out' | 'in';
  readonly otherId: string;
  readonly strength: number;
  readonly confidence: number;
  readonly count: number;
  readonly signals: readonly string[];
  readonly provenance: readonly string[];
  readonly rationale?: string;
};

export type MergeProvenanceRecord = {
  readonly mergedId: string;
  readonly mergedName?: string;
  readonly mergedNameNorm?: string;
  readonly mergedType?: string;
  readonly mergedAliases: readonly string[];
  readonly edges: readonly MergeProvenanceEdge[];
  /** Set once this record has been split back out; a second unmerge of the same id is a no-op. */
  readonly unmergedAt?: string;
  /** The stored record verbatim, so rewriting it preserves fields this reader does not name. */
  readonly raw: Record<string, unknown>;
};

export type CanonicalMerge = {
  readonly canonicalId: string;
  readonly aliases: readonly string[];
  readonly records: readonly MergeProvenanceRecord[];
};

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readEdge(value: unknown): MergeProvenanceEdge | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const edge = value as Record<string, unknown>;
  const { type } = edge;
  const otherId = edge.other_id;
  if (typeof type !== 'string' || typeof otherId !== 'string') {
    return undefined;
  }
  const { rationale } = edge;
  return {
    type,
    direction: edge.direction === 'in' ? 'in' : 'out',
    otherId,
    strength: typeof edge.strength === 'number' ? edge.strength : 0,
    confidence: typeof edge.confidence === 'number' ? edge.confidence : 0,
    count: typeof edge.count === 'number' ? edge.count : 0,
    signals: readStringArray(edge.signals),
    provenance: readStringArray(edge.provenance),
    ...(typeof rationale === 'string' ? { rationale } : {}),
  };
}

/** A record that does not parse is skipped rather than thrown on: one bad row is not a dead repair path. */
function readRecord(serialized: string): MergeProvenanceRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const raw = parsed as Record<string, unknown>;
  const mergedId = raw.merged_id;
  if (typeof mergedId !== 'string') {
    return undefined;
  }
  const edges = Array.isArray(raw.edges)
    ? (raw.edges as unknown[])
        .map(readEdge)
        .filter((edge): edge is MergeProvenanceEdge => edge !== undefined)
    : [];
  const name = raw.merged_name;
  const nameNorm = raw.merged_name_norm;
  const type = raw.merged_type;
  const unmergedAt = raw.unmerged_at;
  return {
    mergedId,
    ...(typeof name === 'string' ? { mergedName: name } : {}),
    ...(typeof nameNorm === 'string' ? { mergedNameNorm: nameNorm } : {}),
    ...(typeof type === 'string' ? { mergedType: type } : {}),
    mergedAliases: readStringArray(raw.merged_aliases),
    edges,
    ...(typeof unmergedAt === 'string' ? { unmergedAt } : {}),
    raw,
  };
}

/**
 * The canonical that absorbed a given node, reached through the lineage edge the merge wrote.
 * An unmerge adds a second `SUPERSEDES` into the same node from the restored identity, so the
 * match is narrowed to the side that actually carries a merge record.
 */
const FIND_CANONICAL_FOR_MERGED = [
  `MATCH (canonical:Entity)-[:SUPERSEDES]->(merged:Entity { id: $mergedId })`,
  `WHERE canonical.${MERGE_PROVENANCE_PROPERTY} IS NOT NULL`,
  'RETURN canonical.id AS canonical_id,',
  `       coalesce(canonical.${ENTITY_ALIASES_PROPERTY}, []) AS aliases,`,
  `       coalesce(canonical.${MERGE_PROVENANCE_PROPERTY}, []) AS records`,
  'LIMIT 1',
].join('\n');

export async function readCanonicalMerge(
  driver: Driver,
  mergedId: string,
): Promise<CanonicalMerge | undefined> {
  const rows = await runRead(driver, FIND_CANONICAL_FOR_MERGED, { mergedId }, (row) => ({
    canonicalId: row.canonical_id as string,
    aliases: readStringArray(row.aliases),
    records: readStringArray(row.records)
      .map(readRecord)
      .filter((record): record is MergeProvenanceRecord => record !== undefined),
  }));
  return rows[0];
}

const READ_CANONICAL_MERGE_RECORDS = [
  'MATCH (canonical:Entity { id: $canonicalId })',
  'RETURN canonical.id AS canonical_id,',
  `       coalesce(canonical.${ENTITY_ALIASES_PROPERTY}, []) AS aliases,`,
  `       coalesce(canonical.${MERGE_PROVENANCE_PROPERTY}, []) AS records`,
].join('\n');

/** The other direction: what one canonical has absorbed, for a caller listing repair candidates. */
export async function readCanonicalMergeRecords(
  driver: Driver,
  canonicalId: string,
): Promise<CanonicalMerge | undefined> {
  const rows = await runRead(driver, READ_CANONICAL_MERGE_RECORDS, { canonicalId }, (row) => ({
    canonicalId: row.canonical_id as string,
    aliases: readStringArray(row.aliases),
    records: readStringArray(row.records)
      .map(readRecord)
      .filter((record): record is MergeProvenanceRecord => record !== undefined),
  }));
  return rows[0];
}

/**
 * The suffix that releases an identity key. `entity_name_unique` covers every Entity node
 * whatever its currency, and entity extraction leans on that: a closed duplicate still owns
 * its `name_norm` key and the MERGE walks the lineage chain forward from it to
 * the canonical. So an unmerge that left the key where it is would restore the node and then
 * watch the next extraction resolve straight past it to the canonical again. The closed node
 * hands the key over and keeps its display name, and the original spelling stays on the
 * canonical's merge record.
 */
export function releasedNameNorm(nameNorm: string, mergedId: string): string {
  return `${nameNorm}#unmerged:${mergedId}`;
}

const RELEASE_IDENTITY_KEY = [
  'MATCH (merged:Entity { id: $mergedId })',
  `SET merged.${ENTITY_NAME_NORM_PROPERTY} = $released`,
  'RETURN merged.id AS id',
].join('\n');

const FIND_EXISTING_NODES = [
  'UNWIND $ids AS wantedId',
  `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
  'RETURN n.id AS id',
].join('\n');

export type UnmergeInput = {
  readonly canonicalId: string;
  /** The record being split back out; it must carry the absorbed node's identity. */
  readonly record: MergeProvenanceRecord;
  readonly canonicalAliases: readonly string[];
  /** Every record on the canonical, rewritten together so the property is set once. */
  readonly records: readonly MergeProvenanceRecord[];
  readonly now: Date;
};

export type UnmergeResult = {
  readonly restoredId: string;
  readonly edgesRestored: number;
  /** Recorded edges whose other endpoint is no longer in the graph. */
  readonly edgesSkipped: number;
  readonly aliasesReleased: number;
};

async function existingNodeIds(
  tx: GraphTransaction,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Set();
  }
  const rows = await tx.run(FIND_EXISTING_NODES, { ids: unique }, (row) => row.id as string);
  return new Set(rows);
}

function rewriteRecords(
  records: readonly MergeProvenanceRecord[],
  mergedId: string,
  restoredId: string,
  now: Date,
): string[] {
  return records.map((record) => {
    if (record.mergedId !== mergedId) {
      return JSON.stringify(record.raw);
    }
    return JSON.stringify({
      ...record.raw,
      unmerged_at: now.toISOString(),
      unmerged_into: restoredId,
    });
  });
}

/**
 * One transaction, because every half of this is invalid on its own: a released key with no
 * node holding it loses the identity, and a restored node without the canonical's alias
 * release leaves two nodes claiming the same name.
 *
 * The canonical's own edges are left exactly as they are. The merge summed and maxed them
 * into whatever was already there, so there is no arithmetic that takes the split identity's
 * contribution back out, and a subtraction that guessed would be worse than an edge that is
 * now slightly overstated.
 */
export async function applyUnmerge(driver: Driver, input: UnmergeInput): Promise<UnmergeResult> {
  const { record } = input;
  const nameNorm = record.mergedNameNorm;
  const type = record.mergedType;
  if (nameNorm === undefined || type === undefined) {
    throw new Error(`merge record for ${record.mergedId} carries no identity to restore`);
  }

  return inWriteTransaction(driver, async (tx) => {
    await lockNodeInTransaction(tx, input.canonicalId, input.now);
    await lockNodeInTransaction(tx, record.mergedId, input.now);

    await tx.run(
      RELEASE_IDENTITY_KEY,
      { mergedId: record.mergedId, released: releasedNameNorm(nameNorm, record.mergedId) },
      (row) => row.id as string,
    );

    const restored = await writeStampedNodeInTransaction(tx, {
      label: 'Entity',
      now: input.now,
      properties: {
        [ENTITY_NAME_PROPERTY]: record.mergedName ?? nameNorm,
        [ENTITY_NAME_NORM_PROPERTY]: nameNorm,
        [ENTITY_NAME_SQUASH_PROPERTY]: squashName(nameNorm),
        [ENTITY_TYPE_PROPERTY]: type,
        [ENTITY_ALIASES_PROPERTY]: [...record.mergedAliases],
        [ENTITY_ALIASES_NORM_PROPERTY]: aliasLookupKeys(record.mergedAliases),
        [ACCESS_COUNT_PROPERTY]: 0,
      },
    });

    const present = await existingNodeIds(
      tx,
      record.edges.map((edge) => edge.otherId),
    );
    let edgesRestored = 0;
    let edgesSkipped = 0;
    for (const edge of record.edges) {
      if (!isRelationshipType(edge.type) || !present.has(edge.otherId)) {
        edgesSkipped += 1;
        continue;
      }
      const sourceId = edge.direction === 'out' ? restored.id : edge.otherId;
      const targetId = edge.direction === 'out' ? edge.otherId : restored.id;
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
      edgesRestored += 1;
    }

    // The restored identity is what the closed node became, so it carries the lineage. The
    // close itself is a no-op: the merge already stamped it and the write coalesces.
    await supersedeInTransaction(tx, {
      oldId: record.mergedId,
      newId: restored.id,
      now: input.now,
      signals: ['entity_unmerge'],
      provenance: ['introspection'],
    });

    const released = new Set([
      ...(record.mergedName === undefined ? [] : [record.mergedName]),
      ...record.mergedAliases,
    ]);
    const aliases = input.canonicalAliases.filter((alias) => !released.has(alias));

    await writeStampedNodeInTransaction(tx, {
      label: 'Entity',
      id: input.canonicalId,
      now: input.now,
      mergeProperties: {
        [ENTITY_ALIASES_PROPERTY]: aliases,
        [ENTITY_ALIASES_NORM_PROPERTY]: aliasLookupKeys(aliases),
        [MERGE_PROVENANCE_PROPERTY]: rewriteRecords(
          input.records,
          record.mergedId,
          restored.id,
          input.now,
        ),
      },
    });

    return {
      restoredId: restored.id,
      edgesRestored,
      edgesSkipped,
      aliasesReleased: input.canonicalAliases.length - aliases.length,
    };
  });
}
