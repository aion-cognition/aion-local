import type { SqliteHandle } from './database.js';
import { readCitationsOf } from './narrative-citations.js';
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';

/**
 * The reads behind the recall self-probe, all of them over the durable records rather than the
 * graph.
 *
 * The probe used to anchor an Episode projection and traverse live relationships, which made
 * eviction look like forgetting: a source whose projection was removed left the denominator and
 * a memory whose edges were rewritten became an automatic miss. Every question here is asked of
 * the records instead, so a physically evicted source is sampled, resolved and scored exactly
 * as a resident one.
 */

export type AcceptedSourceSample = {
  readonly sourceId: string;
  readonly sessionId: string;
  /** The verified acceptance moment, which is the only clock the sampler may age on. */
  readonly acceptedAt: string;
  /** The world clock the capture claims. Kept for reporting, never for maturity. */
  readonly occurredAt: string;
  readonly verificationStatus: string;
};

/**
 * A random sample of sources accepted before a moment.
 *
 * The cut is acceptance and not `occurred_at`: a backdated capture pushed this morning has a
 * world date years old and has been in the substrate for minutes, and scoring it would measure
 * a pipeline that has not finished with it.
 */
export function sampleSourcesAcceptedBefore(
  db: SqliteHandle,
  before: string,
  limit: number,
): readonly AcceptedSourceSample[] {
  const rows = db
    .prepare(
      `SELECT source_id, session_id, created_at, occurred_at, verification_status
       FROM source_records WHERE created_at < ?
       ORDER BY RANDOM() LIMIT ?`,
    )
    .all(before, limit) as {
    source_id: string;
    session_id: string;
    created_at: string;
    occurred_at: string;
    verification_status: string;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    sessionId: row.session_id,
    acceptedAt: row.created_at,
    occurredAt: row.occurred_at,
    verificationStatus: row.verification_status,
  }));
}

export type SourceReadiness = {
  /** Absent when nothing has allocated and activated a generation for this source. */
  readonly generation: number | undefined;
  /** Work rows the active generation still owes, of every kind. */
  readonly outstanding: number;
  /** Stage rows whose outcome does not say complete or proved not applicable. */
  readonly unfinishedStages: number;
};

/**
 * What C8's records say about whether this source's required processing pass is done.
 *
 * Row presence is not the test: a completed stage carries a typed outcome, so a row with none
 * says nothing about whether its stage happened. An obligation of any other kind is outstanding
 * too, which is what keeps a source whose inventory is still pending out of the sample rather
 * than counted as ready by an empty stage list.
 */
export function readSourceReadiness(db: SqliteHandle, sourceId: string): SourceReadiness {
  const active = db
    .prepare(
      `SELECT processing_generation FROM source_processing_generations
       WHERE source_id = ? AND state = 'active'`,
    )
    .get(sourceId) as { processing_generation: number } | undefined;
  if (active === undefined) {
    return { generation: undefined, outstanding: 0, unfinishedStages: 0 };
  }
  const counts = db
    .prepare(
      `SELECT
         COALESCE(sum(CASE WHEN state IN ('pending','retryable','transferred','pinned')
                           THEN 1 ELSE 0 END), 0) AS outstanding,
         COALESCE(sum(CASE WHEN kind = 'stage' AND (state != 'completed' OR outcome_json IS NULL)
                           THEN 1 ELSE 0 END), 0) AS unfinished
       FROM source_work WHERE source_id = ? AND processing_generation = ?`,
    )
    .get(sourceId, active.processing_generation) as { outstanding: number; unfinished: number };
  return {
    generation: active.processing_generation,
    outstanding: counts.outstanding,
    unfinishedStages: counts.unfinished,
  };
}

/**
 * The roles that make a source stand behind a node.
 *
 * Membership is not one of them. `source_coverage` says a chunk's window included this source,
 * which is a fact about the chunk's boundaries and no evidence at all that the source produced
 * what the pack emitted. Crediting it would make every source in a hundred-source window a hit
 * for anything that window ever summarised.
 */
const RELATED_ROLES: readonly string[] = OWNERSHIP_SCOPES.map((scope) => scope.role);

/**
 * Which of the pack's items the records say this source stands behind: extraction, mention or
 * participation, whichever the writers recorded, plus any published revision that actually
 * cites the source. It is a relationship the substrate can prove, and it is not evidence that
 * the prose answered anything.
 *
 * The two halves are independent on purpose. A published overview citing this source earns the
 * credit whether or not the source is inside its coverage window, and being inside the window
 * earns nothing on its own.
 */
export function relatedIncidenceNodes(
  db: SqliteHandle,
  sourceId: string,
  candidateIds: readonly string[],
  at?: Date,
): readonly string[] {
  const unique = [...new Set(candidateIds)];
  if (unique.length === 0) {
    return [];
  }
  const placeholders = unique.map(() => '?').join(', ');
  const roles = RELATED_ROLES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT DISTINCT s.node_id
       FROM source_incidence s
       JOIN evidence_link_versions v ON v.link_id = s.link_id AND v.version = s.link_version
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
       WHERE s.source_id = ? AND s.role IN (${roles}) AND s.node_id IN (${placeholders})`,
    )
    .all(sourceId, ...RELATED_ROLES, ...unique) as { node_id: string }[];
  const related = new Set(rows.map((row) => row.node_id));
  const candidates = new Set(unique);
  for (const cited of readCitationsOf(db, sourceId, at)) {
    if (candidates.has(cited.narrativeNodeId)) {
      related.add(cited.narrativeNodeId);
    }
  }
  return [...related].sort((left, right) => left.localeCompare(right));
}

export type ServedReferenceOutcome =
  /** A durable incidence acknowledged after the serve, which is proof of a later reference. */
  | 'referenced_after'
  /** Incidence exists and nothing dates it, so whether it came after the serve is unknown. */
  | 'unversioned'
  /** Nothing points at the item, which is a measured absence rather than missing proof. */
  | 'none';

/**
 * Whether the conversation came back to a served memory.
 *
 * The credit needs a clock the substrate assigned: `known_from` is stamped at acknowledgment,
 * so a version carrying one was demonstrably known after the moment it names. A legacy row a
 * backfill discovered later carries none, and crediting it would turn "we found this edge
 * afterwards" into "the member used this memory afterwards".
 */
export function servedReferenceOutcome(
  db: SqliteHandle,
  itemId: string,
  firstServedAt: string,
): ServedReferenceOutcome {
  const later = db
    .prepare(
      `SELECT count(*) AS n
       FROM source_incidence s
       JOIN evidence_link_versions v ON v.link_id = s.link_id
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
       WHERE s.node_id = ? AND v.known_from IS NOT NULL AND v.known_from > ?`,
    )
    .get(itemId, firstServedAt) as { n: number };
  if (later.n > 0) {
    return 'referenced_after';
  }
  const any = db
    .prepare(
      `SELECT count(*) AS n
       FROM source_incidence s
       JOIN evidence_link_versions v ON v.link_id = s.link_id
       WHERE s.node_id = ? AND v.known_from IS NULL`,
    )
    .get(itemId) as { n: number };
  return any.n > 0 ? 'unversioned' : 'none';
}
