import {
  NARRATIVE_SCOPES,
  durableRoleScope,
  isRegisteredScope,
  scopeAuthority,
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
import { countMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import { commitSourceIncidence } from '../../infrastructure/sqlite/source-incidence.js';
import {
  nodeScopeDirection,
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
 * The roles a source can stand behind a retained node in, which is what support is read from.
 *
 * Each is counted at the direction the scope registry puts it under, not at a uniform `in`. A
 * census filed under a direction nothing reads is a census nobody can see.
 */
const SUPPORT_ROLES = ['extraction', 'mention', 'participation', 'source_coverage'] as const;

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
      },
      temporalProof: { basis: 'legacy_relationship_clocks', ...entry.clocks },
      observedAt: write.observedAt,
    });
    if (!outcome.recorded) {
      preserved += 1;
      continue;
    }
    recorded += 1;
    if (entry.incident) {
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
  write: Omit<MaterializationWrite, 'links'>,
  knownFrom: string,
  observedAckAt: string,
): void {
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

/** Members the walk has not reached. While this is above zero no census may be established. */
export function unaccountedCohortMembers(db: SqliteHandle, cohortId: string): number {
  return countMigrationProgress(db, cohortId).accounted;
}

/**
 * The endpoints the seal still owes a census, oldest first by id.
 *
 * The population is the scope table itself: every endpoint this migration moved a counter for and
 * has not yet counted. Paging on the endpoint keeps the seal bounded and restartable, and an
 * endpoint whose scopes are all established drops out of the page on the next call.
 */
export function pageUncountedEndpoints(
  db: SqliteHandle,
  after: string,
  limit: number,
): readonly string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT endpoint_id FROM evidence_scope_versions
       WHERE census_status <> 'established' AND endpoint_id > ?
       ORDER BY endpoint_id LIMIT ?`,
    )
    .all(after, limit) as { endpoint_id: string }[];
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
 * Every scope the seal counts for one endpoint.
 *
 * The scopes it already carries, plus — for a node endpoint — the full support set at each role's
 * REGISTERED direction and the narrative citation scope. A role with no row at all is exactly
 * where a missing count hides: leaving it out would establish three of four censuses and let the
 * fourth keep the whole support answer unknown forever. The pass enumerated each source's complete
 * incident set, so once the cohort is walked a role with no row on a touched node is a counted
 * zero.
 *
 * Graph-authority scopes are never touched here. Their counter lives in the other store, and this
 * side holds only a mirror of what it said at some moment.
 */
export function endpointCensusScopes(db: SqliteHandle, endpointId: string): readonly string[] {
  const rows = db
    .prepare('SELECT relation_class FROM evidence_scope_versions WHERE endpoint_id = ?')
    .all(endpointId) as { relation_class: string }[];
  const scopes = new Set(
    rows
      .map((row) => row.relation_class)
      .filter((scope) => isRegisteredScope(scope) && scopeAuthority(scope) === 'sqlite'),
  );
  if (isNodeEndpoint(db, endpointId)) {
    for (const role of SUPPORT_ROLES) {
      scopes.add(durableRoleScope(role, nodeScopeDirection(role)));
    }
    scopes.add(NARRATIVE_SCOPES[0]);
  }
  return [...scopes].sort();
}

export type CensusWrite = {
  readonly operationId: string;
  readonly endpoints: readonly {
    readonly endpointId: string;
    readonly scopes: readonly string[];
  }[];
  readonly observedAt: Date;
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
      const published = acknowledgeScopeAdvance(db, {
        endpointId: endpoint.endpointId,
        relationClass,
        operationId: write.operationId,
        updatedAt: new Date(knownFrom),
        censusStatus: 'established',
        coverageJson: JSON.stringify({ basis: 'legacy_cohort_seal' }),
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
