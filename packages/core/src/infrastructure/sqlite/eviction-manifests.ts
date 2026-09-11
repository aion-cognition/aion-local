import type { SqliteHandle } from './database.js';

/**
 * What an eviction is about to remove, and the work its removal owes the nodes that stay.
 *
 * The manifest row is written before anything is deleted and is never edited afterwards: it is
 * the record a recovery reads when the graph has already changed and the acknowledgment has not
 * landed, and a row that could be rewritten could not answer that question. Its digest is bound
 * into the publication intent, so a manifest that disagrees with the intent invalidates the
 * attempt rather than being trusted as the newer of two stories.
 *
 * Survivor work lives in `source_work` under the evicted source's active generation rather than
 * in a table of its own. It is the obligation that source's eviction created, the readiness
 * records already carry states, due times, attempts and typed outcomes for exactly this, and an
 * acknowledgment there is read the same way every other obligation's is. A task is written
 * `pinned`, which is the state that owes something and is not runnable; the acknowledgment is
 * what dates it and makes it so. An attempt that never committed leaves every task pinned, which
 * is the point: an aborted deletion cannot pretend the topology moved.
 */

export const SURVIVOR_WORK_KIND = 'survivor_recompute';

export type EvictionManifestRow = {
  readonly operationId: string;
  readonly removalSetJson: string;
  readonly contentDigestsJson: string;
  readonly evidenceVersionsJson: string;
  readonly incidentEdgesJson: string;
  readonly survivorObligationsJson: string;
  readonly readinessPolicyRevision: number;
  readonly expectedOutcomeJson: string;
  readonly createdAt: string;
};

export function writeEvictionManifest(db: SqliteHandle, row: EvictionManifestRow): void {
  db.prepare(
    `INSERT INTO eviction_manifests
       (operation_id, removal_set_json, content_digests_json, evidence_versions_json,
        incident_edges_json, survivor_obligations_json, readiness_policy_revision,
        expected_outcome_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (operation_id) DO NOTHING`,
  ).run(
    row.operationId,
    row.removalSetJson,
    row.contentDigestsJson,
    row.evidenceVersionsJson,
    row.incidentEdgesJson,
    row.survivorObligationsJson,
    row.readinessPolicyRevision,
    row.expectedOutcomeJson,
    row.createdAt,
  );
}

export function readEvictionManifest(
  db: SqliteHandle,
  operationId: string,
): EvictionManifestRow | undefined {
  const row = db
    .prepare(
      `SELECT operation_id, removal_set_json, content_digests_json, evidence_versions_json,
              incident_edges_json, survivor_obligations_json, readiness_policy_revision,
              expected_outcome_json, created_at
       FROM eviction_manifests WHERE operation_id = ?`,
    )
    .get(operationId) as
    | {
        operation_id: string;
        removal_set_json: string;
        content_digests_json: string;
        evidence_versions_json: string;
        incident_edges_json: string;
        survivor_obligations_json: string;
        readiness_policy_revision: number;
        expected_outcome_json: string;
        created_at: string;
      }
    | undefined;
  return row === undefined
    ? undefined
    : {
        operationId: row.operation_id,
        removalSetJson: row.removal_set_json,
        contentDigestsJson: row.content_digests_json,
        evidenceVersionsJson: row.evidence_versions_json,
        incidentEdgesJson: row.incident_edges_json,
        survivorObligationsJson: row.survivor_obligations_json,
        readinessPolicyRevision: row.readiness_policy_revision,
        expectedOutcomeJson: row.expected_outcome_json,
        createdAt: row.created_at,
      };
}

export type SurvivorObligation = {
  readonly nodeId: string;
  /**
   * The physical neighbourhood the eviction saw, recorded as provenance for the obligation. It is
   * NOT what the repair pass retries against: the removal itself moves the neighbourhood, so a
   * comparison against this reading would always differ. The retry comparison spans the read the
   * recomputation was taken over, and lives in the repair pass.
   */
  readonly neighborhoodRevision: string;
};

/** The reason a discarded attempt's obligation carries while it waits to be re-adopted. */
export const SURVIVOR_DISCARDED_REASON = 'eviction_discarded';

export function survivorWorkId(operationId: string, nodeId: string): string {
  return `${SURVIVOR_WORK_KIND}:${operationId}:${nodeId}`;
}

/**
 * Writes one pinned task per affected survivor, inside the caller's durable preparation, and
 * RE-ADOPTS one an earlier attempt left behind.
 *
 * The re-adoption is the load-bearing half. `source_work` is unique on
 * (source, generation, kind, key), so an attempt that prepared a row and then died leaves that
 * key taken; an insert that did nothing on conflict would let the retry commit a deletion while
 * the obligation for it stayed parked under the earlier, rejected operation — owed by nobody,
 * released by nothing, and invisible to a runnability read that only follows acknowledged
 * intents. The survivor would keep a context vector computed from a neighbourhood that no longer
 * exists, permanently.
 *
 * So a row this attempt finds in a state that owes something and cannot run — `pinned` from an
 * interrupted attempt, `obsolete` from a discarded one — is repointed at this operation with this
 * attempt's binding. A row that is already runnable or completed is left exactly as it is: it
 * belongs to a removal that committed, and this attempt has no standing to reset it.
 *
 * The operational revision is deliberately NOT advanced here. A pinned row is not runnable and
 * owes nothing yet, and advancing the counter would invalidate the readiness proof this very
 * attempt bound a moment earlier, so the guard's recheck would refuse the operation that wrote
 * it. The acknowledgment is where the work starts to exist.
 *
 * Returns the number of rows this attempt now owns.
 */
export function prepareSurvivorWork(
  db: SqliteHandle,
  input: {
    readonly operationId: string;
    readonly sourceId: string;
    readonly processingGeneration: number;
    readonly obligations: readonly SurvivorObligation[];
  },
): number {
  const insert = db.prepare(
    `INSERT INTO source_work
       (work_id, source_id, processing_generation, kind, work_key, state,
        input_revision_json, publication_operation_id)
     VALUES (?, ?, ?, ?, ?, 'pinned', ?, ?)
     ON CONFLICT (source_id, processing_generation, kind, work_key) DO UPDATE SET
       state = 'pinned',
       reason = NULL,
       due_at = NULL,
       input_revision_json = excluded.input_revision_json,
       publication_operation_id = excluded.publication_operation_id
     WHERE source_work.state IN ('pinned', 'obsolete')`,
  );
  for (const obligation of input.obligations) {
    insert.run(
      survivorWorkId(input.operationId, obligation.nodeId),
      input.sourceId,
      input.processingGeneration,
      SURVIVOR_WORK_KIND,
      obligation.nodeId,
      JSON.stringify({ neighborhoodRevision: obligation.neighborhoodRevision }),
      input.operationId,
    );
  }
  // Read back rather than counted from the loop: a row already runnable under an acknowledged
  // removal is left alone by the conflict clause, so what this attempt asked for and what it owns
  // are two different numbers and only the second one is true.
  return countSurvivorWorkOf(db, input.operationId);
}

/**
 * Makes this operation's pinned survivor tasks runnable, and returns how many moved.
 *
 * Scoped to the operation that owns them and to the pinned state, so a repeated acknowledgment
 * dates nothing twice and a task another pass already completed stays completed.
 */
export function releaseSurvivorWork(db: SqliteHandle, operationId: string, dueAt: Date): number {
  return db
    .prepare(
      `UPDATE source_work SET state = 'pending', due_at = ?
       WHERE publication_operation_id = ? AND kind = ? AND state = 'pinned'`,
    )
    .run(dueAt.toISOString(), operationId, SURVIVOR_WORK_KIND).changes;
}

/**
 * Parks this attempt's still-pinned obligations when the attempt is rejected.
 *
 * Nothing was deleted, so nothing is owed on the topology as it stands — but the row is kept
 * rather than removed, because it is the record that an attempt intended to create that work and
 * a later attempt has to be able to find it. `prepareSurvivorWork` re-adopts it; until then it is
 * explicitly obsolete with a reason instead of sitting pinned forever with no owner that can
 * release it. Returns how many were parked.
 */
export function discardSurvivorWork(db: SqliteHandle, operationId: string): number {
  return db
    .prepare(
      `UPDATE source_work SET state = 'obsolete', reason = ?
       WHERE publication_operation_id = ? AND kind = ? AND state = 'pinned'`,
    )
    .run(SURVIVOR_DISCARDED_REASON, operationId, SURVIVOR_WORK_KIND).changes;
}

/** How many survivor obligations one operation currently owns, whatever state they are in. */
export function countSurvivorWorkOf(db: SqliteHandle, operationId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM source_work
       WHERE publication_operation_id = ? AND kind = ?`,
    )
    .get(operationId, SURVIVOR_WORK_KIND) as { n: number };
  return row.n;
}

export type SurvivorTask = {
  readonly workId: string;
  readonly sourceId: string;
  readonly processingGeneration: number;
  readonly nodeId: string;
  readonly operationId: string | null;
  readonly neighborhoodRevision: string | null;
  readonly state: string;
  readonly attempts: number;
};

function toTask(row: {
  work_id: string;
  source_id: string;
  processing_generation: number;
  work_key: string;
  publication_operation_id: string | null;
  input_revision_json: string | null;
  state: string;
  attempts: number;
}): SurvivorTask {
  const bound =
    row.input_revision_json === null
      ? undefined
      : (JSON.parse(row.input_revision_json) as { neighborhoodRevision?: string });
  return {
    workId: row.work_id,
    sourceId: row.source_id,
    processingGeneration: row.processing_generation,
    nodeId: row.work_key,
    operationId: row.publication_operation_id,
    neighborhoodRevision: bound?.neighborhoodRevision ?? null,
    state: row.state,
    attempts: row.attempts,
  };
}

/**
 * Survivor tasks a run may act on: due, and owned by an operation the records say was
 * acknowledged.
 *
 * The acknowledgment test is a join on the intent rather than a flag on the row, because what
 * makes a task runnable is the committed receipt behind it and a flag is a second copy of that
 * fact. Ordered by due time then work id, which is total and repeatable, so a run pages through
 * the backlog instead of meeting the same head every tick.
 */
export function listRunnableSurvivorWork(
  db: SqliteHandle,
  dueBy: Date,
  limit: number,
): readonly SurvivorTask[] {
  const rows = db
    .prepare(
      `SELECT w.work_id, w.source_id, w.processing_generation, w.work_key,
              w.publication_operation_id, w.input_revision_json, w.state, w.attempts
       FROM source_work w
       JOIN publication_intents i ON i.operation_id = w.publication_operation_id
        AND i.state = 'acknowledged'
       WHERE w.kind = ? AND w.state IN ('pending','retryable') AND w.due_at <= ?
       ORDER BY w.due_at, w.work_id
       LIMIT ?`,
    )
    .all(SURVIVOR_WORK_KIND, dueBy.toISOString(), limit) as {
    work_id: string;
    source_id: string;
    processing_generation: number;
    work_key: string;
    publication_operation_id: string | null;
    input_revision_json: string | null;
    state: string;
    attempts: number;
  }[];
  return rows.map(toTask);
}

/** Survivor tasks this operation still owes, whatever state they are in. */
export function survivorWorkOf(db: SqliteHandle, operationId: string): readonly SurvivorTask[] {
  const rows = db
    .prepare(
      `SELECT work_id, source_id, processing_generation, work_key, publication_operation_id,
              input_revision_json, state, attempts
       FROM source_work WHERE publication_operation_id = ? AND kind = ?
       ORDER BY work_key`,
    )
    .all(operationId, SURVIVOR_WORK_KIND) as {
    work_id: string;
    source_id: string;
    processing_generation: number;
    work_key: string;
    publication_operation_id: string | null;
    input_revision_json: string | null;
    state: string;
    attempts: number;
  }[];
  return rows.map(toTask);
}

/** How many survivor tasks are owed and runnable now, for the demand reading. */
export function countRunnableSurvivorWork(db: SqliteHandle, dueBy: Date): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM source_work w
       JOIN publication_intents i ON i.operation_id = w.publication_operation_id
        AND i.state = 'acknowledged'
       WHERE w.kind = ? AND w.state IN ('pending','retryable') AND w.due_at <= ?`,
    )
    .get(SURVIVOR_WORK_KIND, dueBy.toISOString()) as { n: number };
  return row.n;
}

/** Dates a task forward after a neighbourhood moved under it. Nothing is discharged by a retry. */
export function deferSurvivorWork(db: SqliteHandle, workId: string, dueAt: Date): void {
  db.prepare(
    `UPDATE source_work SET state = 'retryable', due_at = ?, attempts = attempts + 1
     WHERE work_id = ? AND state IN ('pending','retryable')`,
  ).run(dueAt.toISOString(), workId);
}
