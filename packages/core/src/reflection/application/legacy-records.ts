import { NODE_SUPPORT_ROLE_SCOPES } from '../../evidence/application/node-support.js';
import {
  durableRoleScope,
  nodeScopeDirection,
  type ScopeDirection,
} from '../../evidence/domain/scopes.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeStatedLinkVersions,
  prepareMaterializedLinkVersion,
} from '../../infrastructure/sqlite/evidence-links.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import {
  countMigrationProgress,
  readMigrationCohort,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import { commitSourceIncidence } from '../../infrastructure/sqlite/source-incidence.js';
import {
  roleOfLinkKind,
  type MaterializedLink,
  type ScopeAdvanceKey,
} from '../domain/legacy-materialization.js';

/**
 * The durable half of the guarded legacy materialization, and the census seal that follows it.
 *
 * Two writes, deliberately separated. A source's pass records its links, its versions and its
 * role-qualified incidence, and moves the scope counters those rows sit in. It does NOT count
 * anything: a scope's census is a statement about the whole population behind it, and one source
 * of many cannot make it. The seal makes it, once every member of the frozen cohort has been
 * walked, which is what "established only when all pages account" means in code.
 */

/**
 * A link as the stored plan carries it. The scope role is decided when the plan is made and read
 * back off the plan's own scope list, so the writer never re-derives it from a validated string.
 */
export type PlannedLink = Omit<MaterializedLink, 'scopeRole'>;

export type MaterializationWrite = {
  readonly sourceId: string;
  readonly operationId: string;
  readonly links: readonly PlannedLink[];
  readonly scopes: readonly ScopeAdvanceKey[];
  readonly observedAt: Date;
  /**
   * Whether to write the incidence projection now.
   *
   * The committed incidence view joins through the OPERATION's state, not through the version's
   * clock, so a projection written at prepare becomes visible the moment the operation is
   * acknowledged — including when that operation acknowledged a graph write it did not make. A
   * caller whose graph phase can decline projects in its acknowledgment instead.
   */
  readonly project?: boolean;
};

export type MaterializationCounts = {
  readonly recorded: number;
  /** Links a newer acknowledged version already covers, left exactly as they were. */
  readonly preserved: number;
};

function operationKey(operationId: string, linkId: string): string {
  return `legacy:${operationId}:${linkId}`;
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
 * Writes one source's materialization inside the publication's durable prepare.
 *
 * The incidence row is written against the version this pass took, so a link a newer statement
 * already committed keeps its own pointer rather than being dragged back to a baseline. Nothing
 * here is in the committed view yet: the version carries no `known_from` until acknowledgment,
 * and every committed read joins through that.
 */
export function prepareMaterialization(
  db: SqliteHandle,
  write: MaterializationWrite,
): MaterializationCounts {
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
      recordedValues: {
        currency: entry.closed ? 'closed' : 'open',
        relation_type: entry.relationType,
        ...entry.clocks,
        // What the relationship stated, preserved as it was. Carrying it credits no new
        // confirmation: the version records what somebody once wrote, not that they wrote it now.
        ...entry.recorded,
      },
      temporalProof: { basis: 'legacy_relationship_clocks', ...entry.clocks },
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
      ...scope,
      operationId: write.operationId,
      updatedAt: write.observedAt,
    });
  }
  return { recorded, preserved };
}

/**
 * Promotes what the pass prepared. The scope numbers move; the census status does not, because a
 * single source is not the population.
 */
export function acknowledgeMaterialization(
  db: SqliteHandle,
  write: Omit<MaterializationWrite, 'links'> & { readonly links?: readonly PlannedLink[] },
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
      ...scope,
      operationId: write.operationId,
      updatedAt: new Date(knownFrom),
    });
  }
}

/** Releases the parked numbers. The published tokens a reader already holds stay current. */
export function discardMaterialization(
  db: SqliteHandle,
  write: Omit<MaterializationWrite, 'links'>,
): void {
  for (const scope of write.scopes) {
    rejectScopeAdvance(db, {
      ...scope,
      operationId: write.operationId,
      updatedAt: write.observedAt,
    });
  }
}

/**
 * Members whose evidence this cohort has not materialized: the ones nobody has walked, and the
 * ones the walk pinned.
 *
 * A pin is not a finished member. Its relationships were not materialized, so nobody knows which
 * endpoints it contributes to, and certifying any endpoint while one exists would turn an
 * unmaterialized contribution into a negative read about somebody else's node.
 */
export function unaccountedCohortMembers(db: SqliteHandle, cohortId: string): number {
  const counts = countMigrationProgress(db, cohortId);
  return counts.accounted + counts.pinned;
}

/**
 * The endpoints THIS COHORT walked and still owes a census, oldest first by id.
 *
 * The population is the cohort's own materialization: the links its members wrote, and the two
 * ends of each. A sweep over the whole scope table would count endpoints this cohort never
 * looked at, including ones some other writer advanced and nobody enumerated — registering a
 * scope name is not a census of it.
 */
export function pageUncountedEndpoints(
  db: SqliteHandle,
  cohortId: string,
  after: string,
  limit: number,
): readonly string[] {
  const rows = db
    .prepare(
      `SELECT e.endpoint_id AS endpoint_id FROM (
         SELECT l.from_id AS endpoint_id FROM evidence_links l
         JOIN migration_progress m ON m.source_id = l.from_id AND m.cohort_id = ?
         WHERE l.record_source = 'legacy_materialization'
         UNION
         SELECT l.to_id AS endpoint_id FROM evidence_links l
         JOIN migration_progress m ON m.source_id = l.from_id AND m.cohort_id = ?
         WHERE l.record_source = 'legacy_materialization'
       ) e
       WHERE e.endpoint_id > ?
         AND EXISTS (
           SELECT 1 FROM evidence_scope_versions v
           WHERE v.endpoint_id = e.endpoint_id AND v.census_status <> 'established'
         )
       ORDER BY e.endpoint_id LIMIT ?`,
    )
    .all(cohortId, cohortId, after, limit) as { endpoint_id: string }[];
  return rows.map((row) => row.endpoint_id);
}

/**
 * Whether this endpoint is one something points AT, and therefore one an ownership summary and a
 * support answer are asked about.
 *
 * Decided on the link records rather than on the shape of a scope name. Direction is a per-role
 * registry fact — a claim's own extraction is `extraction:out` on the claim — so a suffix test
 * would read that claim as a source and count the wrong scopes for it.
 */
export function isNodeEndpoint(db: SqliteHandle, endpointId: string): boolean {
  const row = db
    .prepare('SELECT count(*) AS n FROM evidence_links WHERE to_id = ?')
    .get(endpointId) as { n: number };
  return row.n > 0;
}

/**
 * The scopes a seal may CONSIDER for one endpoint: the ones this migration's own records place on
 * it, plus — for a node endpoint — the incidence roles a repair sweep reads.
 *
 * Derived from the link rows the walk wrote, never from the scope table. A scope row is a counter
 * somebody moved, and whoever moved it may have enumerated nothing: adopting the rows an endpoint
 * happens to carry is how a population this pass never looked at ends up counted under a seal that
 * only walked source relationships. The citation scope is the case that proved it — C2 owns the
 * revision records, and nothing here has read them.
 *
 * A role with no row at all is still considered, because that is exactly where a missing count
 * hides: leaving it out would establish three of four censuses and let the fourth keep the whole
 * support answer unknown forever. Whether the absence is a proved zero is decided by the coverage
 * proof over the endpoint's graph population, not here.
 *
 * Graph-authority scopes are never touched. Their counter lives in the other store, and this side
 * holds only a mirror of what it said at some moment.
 */
export function endpointCensusScopes(db: SqliteHandle, endpointId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT kind, from_id AS from_id FROM evidence_links
       WHERE record_source = 'legacy_materialization' AND (from_id = ? OR to_id = ?)`,
    )
    .all(endpointId, endpointId) as { kind: string; from_id: string }[];
  const scopes = new Set<string>();
  for (const row of rows) {
    const role = roleOfLinkKind(row.kind);
    if (role === undefined) {
      continue;
    }
    const node = nodeScopeDirection(role);
    const source: ScopeDirection = node === 'in' ? 'out' : 'in';
    scopes.add(durableRoleScope(role, row.from_id === endpointId ? source : node));
  }
  if (isNodeEndpoint(db, endpointId)) {
    for (const scope of NODE_SUPPORT_ROLE_SCOPES) {
      scopes.add(scope);
    }
  }
  return [...scopes].sort();
}

export type CensusCoverage = {
  readonly cohortId: string;
  readonly cohortDigest: string;
  readonly graphCensusDigest: string;
  readonly intakeWatermark: number;
  readonly archiveRowidLow: number;
  readonly archiveRowidHigh: number;
  readonly members: number;
  readonly verified: number;
};

/**
 * What a seal over this cohort rests on: the frozen record itself, and how much of it was proved.
 *
 * Nothing for a cohort nobody froze: a count with no enumeration behind it has no bounds to
 * record and no membership to have accounted for, and the seal defers on the absence.
 */
export function censusCoverage(db: SqliteHandle, cohortId: string): CensusCoverage | undefined {
  const cohort = readMigrationCohort(db, cohortId);
  if (cohort === undefined) {
    return undefined;
  }
  const counts = countMigrationProgress(db, cohortId);
  return {
    cohortId: cohort.cohortId,
    cohortDigest: cohort.cohortDigest,
    graphCensusDigest: cohort.graphCensusDigest,
    intakeWatermark: cohort.intakeWatermark,
    archiveRowidLow: cohort.archiveRowidLow,
    archiveRowidHigh: cohort.archiveRowidHigh,
    members: counts.accounted + counts.verified + counts.pinned,
    verified: counts.verified,
  };
}

/** What proved ONE scope's population: the sources behind it, or the source it belongs to. */
export type ScopeProof = {
  readonly scope: string;
  readonly contributors: readonly string[];
};

export type CensusWrite = {
  readonly operationId: string;
  readonly endpoints: readonly {
    readonly endpointId: string;
    readonly scopes: readonly string[];
    /**
     * Per scope, who was walked to prove it. Stored with THAT scope and no other: a cohort digest
     * says a migration finished, which is not the same claim as this population being accounted
     * for, and one endpoint's scopes are proved by different sets of sources.
     */
    readonly proof?: readonly ScopeProof[];
  }[];
  readonly observedAt: Date;
  /** What the count rests on, stored with it. A label is not proof that anything was walked. */
  readonly coverage: Readonly<Record<string, unknown>>;
};

export function prepareCensusSeal(db: SqliteHandle, write: CensusWrite): number {
  let prepared = 0;
  for (const endpoint of write.endpoints) {
    for (const relationClass of endpoint.scopes) {
      prepareScopeAdvance(db, {
        endpointId: endpoint.endpointId,
        relationClass,
        operationId: write.operationId,
        updatedAt: write.observedAt,
      });
      prepared += 1;
    }
  }
  return prepared;
}

/** The one place a census status becomes `established`, and only inside the acknowledgment. */
export function acknowledgeCensusSeal(
  db: SqliteHandle,
  write: CensusWrite,
  knownFrom: string,
): number {
  let established = 0;
  for (const endpoint of write.endpoints) {
    for (const relationClass of endpoint.scopes) {
      const proof = endpoint.proof?.find((entry) => entry.scope === relationClass);
      const published = acknowledgeScopeAdvance(db, {
        endpointId: endpoint.endpointId,
        relationClass,
        operationId: write.operationId,
        updatedAt: new Date(knownFrom),
        censusStatus: 'established',
        coverageJson: JSON.stringify({
          ...write.coverage,
          scope: relationClass,
          ...(proof === undefined ? {} : { contributors: proof.contributors }),
        }),
      });
      if (published !== undefined) {
        established += 1;
      }
    }
  }
  return established;
}

export function discardCensusSeal(db: SqliteHandle, write: CensusWrite): void {
  for (const endpoint of write.endpoints) {
    for (const relationClass of endpoint.scopes) {
      rejectScopeAdvance(db, {
        endpointId: endpoint.endpointId,
        relationClass,
        operationId: write.operationId,
        updatedAt: write.observedAt,
      });
    }
  }
}
