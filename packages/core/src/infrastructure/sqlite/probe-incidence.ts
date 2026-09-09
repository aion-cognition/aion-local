import { committedIncidenceForSourceAt } from './committed-evidence.js';
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
  const unique = new Set(candidateIds);
  if (unique.size === 0) {
    return [];
  }
  const related = new Set<string>();
  // The historical reader, not the current projection. `source_incidence` says who owns a node
  // now; a question about an earlier vantage is answered from the link's own acknowledged
  // version chain, so a mention accepted after the scoring moment does not earn credit for it.
  for (const incidence of committedIncidenceForSourceAt(db, sourceId, at)) {
    if (RELATED_ROLES.includes(incidence.role) && unique.has(incidence.nodeId)) {
      related.add(incidence.nodeId);
    }
  }
  for (const cited of readCitationsOf(db, sourceId, at)) {
    if (unique.has(cited.narrativeNodeId)) {
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
 * The basis a version declares for the clocks it carries. A materialization says so, and says
 * it because the moment it was written is not the moment the relationship it preserves happened.
 */
const MIGRATION_BASIS = 'legacy_relationship_clocks';

/**
 * When the reference this version records actually happened, read from the proof basis the
 * version itself declares.
 *
 * An ordinary acceptance is its own event: the substrate observed the reference as it arrived,
 * so `observed_at` is the reference's time. A materialization is not: it observed a *record* of
 * something older, preserved that relationship's own clocks beside its declared basis, and
 * stamped `observed_at` with the migration. Reading the migration's stamp as the reference time
 * is how discovering an old edge becomes the member using a memory again.
 *
 * Nothing here falls back across clocks. A materialization whose preserved clocks say nothing
 * usable leaves the timing unproved, because a knowledge or acknowledgment stamp is an answer
 * to a different question and substituting one for the other is the error itself.
 */
function referenceTimeOf(
  observedAt: string,
  temporalProofJson: string,
): { readonly at: string } | { readonly at: undefined } {
  let proof: Record<string, unknown>;
  try {
    proof = JSON.parse(temporalProofJson) as Record<string, unknown>;
  } catch {
    return { at: undefined };
  }
  if (proof.basis !== MIGRATION_BASIS) {
    return { at: observedAt };
  }
  const original = proof.valid_from ?? proof.tx_from ?? proof.occurred_at;
  return typeof original === 'string' ? { at: original } : { at: undefined };
}

type ReferenceVersionRow = {
  observed_at: string;
  temporal_proof_json: string;
  known_from: string | null;
  state: string;
  recorded_values_json: string;
};

/**
 * Whether the conversation came back to a served memory.
 *
 * The credit needs an accepted reference, not merely a later row. A version that closes,
 * retracts or re-materialises an existing link is an acknowledgment about bookkeeping: the
 * mention it edits happened before the serve, and counting the edit would report a tidy-up as
 * the member using the memory again.
 *
 * `known_from` still has to be there — an unacknowledged version is not in the committed view
 * at all — but it is not the clock the comparison uses. That clock comes from the version's own
 * declared proof basis, so a backfill that discovers an old edge today has discovered an old
 * edge and a genuine later acceptance is still credited for happening later.
 */
export function servedReferenceOutcome(
  db: SqliteHandle,
  itemId: string,
  firstServedAt: string,
): ServedReferenceOutcome {
  const roles = RELATED_ROLES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT v.observed_at, v.temporal_proof_json, v.known_from, v.state, v.recorded_values_json
       FROM source_incidence s
       JOIN evidence_link_versions v ON v.link_id = s.link_id
       JOIN publication_intents i ON i.operation_id = v.operation_id AND i.state = 'acknowledged'
       WHERE s.node_id = ? AND s.role IN (${roles}) AND v.known_from IS NOT NULL`,
    )
    .all(itemId, ...RELATED_ROLES) as ReferenceVersionRow[];

  let unproved = false;
  for (const row of rows) {
    if (row.state === 'closed' || closedCurrency(row.recorded_values_json)) {
      continue;
    }
    const reference = referenceTimeOf(row.observed_at, row.temporal_proof_json);
    if (reference.at === undefined) {
      unproved = true;
      continue;
    }
    if (reference.at > firstServedAt) {
      return 'referenced_after';
    }
  }
  if (unproved) {
    return 'unversioned';
  }
  const untimed = db
    .prepare(
      `SELECT count(*) AS n
       FROM source_incidence s
       JOIN evidence_link_versions v ON v.link_id = s.link_id
       WHERE s.node_id = ? AND v.known_from IS NULL`,
    )
    .get(itemId) as { n: number };
  return untimed.n > 0 ? 'unversioned' : 'none';
}

/** Whether the version's recorded values say the relationship it describes is closed. */
function closedCurrency(recordedValuesJson: string): boolean {
  try {
    return (JSON.parse(recordedValuesJson) as { currency?: unknown }).currency === 'closed';
  } catch {
    return false;
  }
}
