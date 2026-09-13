import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { prepareMaterializedLinkVersion } from '../../infrastructure/sqlite/evidence-link-materialization.js';
import { acknowledgeStatedLinkVersions } from '../../infrastructure/sqlite/evidence-links.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { commitSourceIncidence } from '../../infrastructure/sqlite/source-incidence.js';
import { hashContent } from '../domain/content.js';

/**
 * The durable record of a relationship between a source and a retained node, written by whoever
 * made the relationship.
 *
 * Three writes in one act: the link and its version, the incidence projection that says the source
 * currently stands behind the node in a named role, and the scope counters both endpoints carry for
 * that role. A writer that lands the relationship and moves neither counter is nonconforming, and a
 * reader asking the counter that did not move is told nothing changed.
 *
 * Nothing here is in the committed view until the operation that owns it is acknowledged: the
 * version carries no `known_from` before then, and every committed read joins through it.
 */

/** One relationship, in the shape the record writes it. */
export type EvidenceLinkRecord = {
  readonly linkId: string;
  /** The link's recorded classification, which the incidence role must equal. */
  readonly kind: string;
  readonly qualifier: string;
  readonly fromId: string;
  readonly toId: string;
  /** The relationship identity the graph minted, preserved so a rebuild produces this link. */
  readonly relationId: string;
  readonly relationType: string;
  /** True for a link whose current projection is an incidence row. */
  readonly incident: boolean;
  readonly closed: boolean;
  readonly clocks: Readonly<Record<string, string>>;
  /** What the relationship itself said, carried across without becoming a new observation. */
  readonly recorded: Readonly<Record<string, string>>;
};

/** One endpoint's counter, named: which endpoint, and the scope its census is filed under. */
export type ScopeAdvanceKey = {
  readonly endpointId: string;
  readonly relationClass: string;
  /**
   * What this acknowledgment may claim about the population behind the counter.
   *
   * Absent, the number moves and the census status stays where it was: a writer that landed one
   * relationship has counted no population. A basis is supplied only by a caller that minted the
   * endpoint, where the population is whole because this write is the only thing that has ever
   * touched the id.
   */
  readonly censusBasis?: string;
};

/**
 * The relationship identity a link preserves, derived where the writer holds no minted one.
 *
 * A link record keeps the graph relationship's own id so a rebuild produces this link rather than
 * a second one. An upsert that returns no id still has a stable identity: the type and the two
 * endpoints, which is what the graph itself keys the relationship on.
 */
export function derivedRelationId(relationType: string, fromId: string, toId: string): string {
  return hashContent(['graph_relationship', relationType, fromId, toId]);
}

export type EvidenceRecordWrite = {
  readonly sourceId: string;
  readonly operationId: string;
  readonly links: readonly EvidenceLinkRecord[];
  readonly scopes: readonly ScopeAdvanceKey[];
  readonly observedAt: Date;
  /**
   * Whether to write the incidence projection now.
   *
   * The committed incidence view joins through the OPERATION's state, not through the version's
   * clock, so a projection written at prepare becomes visible the moment the operation is
   * acknowledged. A caller whose graph phase can decline projects in its acknowledgment instead.
   */
  readonly project?: boolean;
  /** Where these records came from, stored on the link row. */
  readonly recordSource?: 'derived_node' | 'narrative_coverage';
};

export type EvidenceRecordCounts = {
  readonly recorded: number;
  /** Links a newer acknowledged version already covers, left exactly as they were. */
  readonly preserved: number;
};

function operationKey(operationId: string, linkId: string): string {
  return `evidence:${operationId}:${linkId}`;
}

/**
 * The version this operation appended to a link, or nothing when it appended none.
 *
 * Nothing is the answer for a link a newer acknowledged version already covers: the prepare
 * preserved it and wrote no row. Reading that absence as version 1 is how a survivor sitting at
 * version 2 gets its projection walked back to a baseline this pass never wrote.
 */
function linkVersionOf(db: SqliteHandle, linkId: string, operationId: string): number | undefined {
  const row = db
    .prepare(
      `SELECT MAX(version) AS n FROM evidence_link_versions
       WHERE link_id = ? AND operation_id = ?`,
    )
    .get(linkId, operationId) as { n: number | null };
  return row.n ?? undefined;
}

/**
 * Writes the records inside the publication's durable prepare.
 *
 * The incidence row is written against the version this pass took, so a link a newer statement
 * already committed keeps its own pointer rather than being dragged back to a baseline.
 */
export function prepareEvidenceRecords(
  db: SqliteHandle,
  write: EvidenceRecordWrite,
): EvidenceRecordCounts {
  let recorded = 0;
  let preserved = 0;
  for (const entry of write.links) {
    const outcome = prepareMaterializedLinkVersion(db, {
      linkId: entry.linkId,
      kind: entry.kind,
      qualifier: entry.qualifier,
      fromId: entry.fromId,
      toId: entry.toId,
      originalRelId: entry.relationId,
      operationId: write.operationId,
      operationKey: operationKey(write.operationId, entry.linkId),
      recordSource: write.recordSource ?? 'derived_node',
      recordedValues: {
        currency: entry.closed ? 'closed' : 'open',
        relation_type: entry.relationType,
        ...entry.clocks,
        // What the relationship stated, preserved as it was. Carrying it credits no new
        // confirmation: the version records what somebody once wrote, not that they wrote it now.
        ...entry.recorded,
      },
      temporalProof: { basis: 'recorded_graph_clocks', ...entry.clocks },
      observedAt: write.observedAt,
    });
    if (!outcome.recorded) {
      preserved += 1;
      continue;
    }
    recorded += 1;
    if (entry.incident && write.project !== false) {
      commitSourceIncidence(db, {
        sourceId: entry.fromId,
        nodeId: entry.toId,
        role: entry.kind,
        linkId: entry.linkId,
        linkVersion: outcome.version,
        currency: entry.closed ? 'closed' : 'open',
        clocks: entry.clocks,
      });
    }
  }
  for (const scope of write.scopes) {
    prepareScopeAdvance(db, {
      endpointId: scope.endpointId,
      relationClass: scope.relationClass,
      operationId: write.operationId,
      updatedAt: write.observedAt,
    });
  }
  return { recorded, preserved };
}

/**
 * Promotes what the operation prepared.
 *
 * A scope is acknowledged exactly once here, because the acknowledgment clears the pending slot:
 * a second call on the same counter finds nothing parked and establishes nothing. So a scope that
 * carries a census basis takes it in this one call rather than in a pass of its own afterwards.
 */
export function acknowledgeEvidenceRecords(
  db: SqliteHandle,
  write: Omit<EvidenceRecordWrite, 'links'> & { readonly links?: readonly EvidenceLinkRecord[] },
  knownFrom: string,
  observedAckAt: string,
): void {
  for (const entry of write.links ?? []) {
    if (!entry.incident) {
      continue;
    }
    const linkVersion = linkVersionOf(db, entry.linkId, write.operationId);
    // A preserved link keeps the projection it already has. This pass wrote no version for it, so
    // it has nothing to point the row at, and pointing it anywhere would move a record backwards.
    if (linkVersion === undefined) {
      continue;
    }
    commitSourceIncidence(db, {
      sourceId: entry.fromId,
      nodeId: entry.toId,
      role: entry.kind,
      linkId: entry.linkId,
      linkVersion,
      currency: entry.closed ? 'closed' : 'open',
      clocks: entry.clocks,
    });
  }
  acknowledgeStatedLinkVersions(db, write.operationId, knownFrom, observedAckAt);
  for (const scope of write.scopes) {
    acknowledgeScopeAdvance(db, {
      endpointId: scope.endpointId,
      relationClass: scope.relationClass,
      operationId: write.operationId,
      updatedAt: new Date(knownFrom),
      ...(scope.censusBasis === undefined
        ? {}
        : {
            censusStatus: 'established' as const,
            coverageJson: JSON.stringify({
              basis: scope.censusBasis,
              endpointId: scope.endpointId,
              scope: scope.relationClass,
              sourceId: write.sourceId,
              knownFrom,
            }),
          }),
    });
  }
}

/** Releases the parked numbers. The published tokens a reader already holds stay current. */
export function discardEvidenceRecords(
  db: SqliteHandle,
  write: Omit<EvidenceRecordWrite, 'links'>,
): void {
  for (const scope of write.scopes) {
    rejectScopeAdvance(db, {
      endpointId: scope.endpointId,
      relationClass: scope.relationClass,
      operationId: write.operationId,
      updatedAt: write.observedAt,
    });
  }
}
