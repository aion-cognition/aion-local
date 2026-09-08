import type { SqliteHandle } from './database.js';

/**
 * Processing generations and the work a generation owes.
 *
 * A generation is allocated durably before anything outside uses it, and a number that was
 * handed out is spent whether or not it ever became active. At most one generation per source
 * is active, which the store enforces rather than the caller.
 *
 * `operational_revision` is the counter a readiness proof binds to, alongside the source and
 * the generation. The generation alone cannot say whether a newly owed work row landed after
 * the proof was made, so every committed change to what a generation owes advances the counter
 * in the same transaction as the change. A completion arriving for a generation that has since
 * been replaced advances nothing: it cannot discharge work the replacement owns.
 *
 * What readiness requires is a policy question answered elsewhere. These helpers store the
 * answers and refuse the shapes the record cannot hold.
 */
export type ProcessingGenerationState = 'allocated' | 'active' | 'replaced';

export type ProcessingGeneration = {
  readonly sourceId: string;
  readonly processingGeneration: number;
  readonly policyRevision: number;
  readonly inputDigest: string | null;
  readonly state: ProcessingGenerationState;
  readonly inventoryComplete: boolean;
  readonly operationalRevision: number;
};

type GenerationRowData = {
  source_id: string;
  processing_generation: number;
  policy_revision: number;
  input_digest: string | null;
  state: ProcessingGenerationState;
  inventory_complete: number;
  operational_revision: number;
};

const SELECT_GENERATION = `SELECT source_id, processing_generation, policy_revision, input_digest,
    state, inventory_complete, operational_revision
  FROM source_processing_generations`;

function toGeneration(row: GenerationRowData): ProcessingGeneration {
  return {
    sourceId: row.source_id,
    processingGeneration: row.processing_generation,
    policyRevision: row.policy_revision,
    inputDigest: row.input_digest,
    state: row.state,
    inventoryComplete: row.inventory_complete === 1,
    operationalRevision: row.operational_revision,
  };
}

export function readActiveGeneration(
  db: SqliteHandle,
  sourceId: string,
): ProcessingGeneration | undefined {
  const row = db
    .prepare(`${SELECT_GENERATION} WHERE source_id = ? AND state = 'active'`)
    .get(sourceId) as GenerationRowData | undefined;
  return row === undefined ? undefined : toGeneration(row);
}

export function readGeneration(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
): ProcessingGeneration | undefined {
  const row = db
    .prepare(`${SELECT_GENERATION} WHERE source_id = ? AND processing_generation = ?`)
    .get(sourceId, processingGeneration) as GenerationRowData | undefined;
  return row === undefined ? undefined : toGeneration(row);
}

/** Every generation a source has had, oldest first. */
export function listGenerations(
  db: SqliteHandle,
  sourceId: string,
): readonly ProcessingGeneration[] {
  const rows = db
    .prepare(`${SELECT_GENERATION} WHERE source_id = ? ORDER BY processing_generation`)
    .all(sourceId) as GenerationRowData[];
  return rows.map(toGeneration);
}

export type GenerationAllocation = {
  readonly sourceId: string;
  readonly policyRevision: number;
  readonly inputDigest?: string;
  readonly createdAt: Date;
};

/** Takes the next generation number for a source. It is allocated, not yet active. */
export function allocateProcessingGeneration(
  db: SqliteHandle,
  allocation: GenerationAllocation,
): number {
  return db
    .transaction((): number => {
      const high = db
        .prepare(
          'SELECT COALESCE(MAX(processing_generation), 0) AS n FROM source_processing_generations WHERE source_id = ?',
        )
        .get(allocation.sourceId) as { n: number };
      const processingGeneration = high.n + 1;
      db.prepare(
        `INSERT INTO source_processing_generations
           (source_id, processing_generation, policy_revision, input_digest, state, created_at)
         VALUES (?, ?, ?, ?, 'allocated', ?)`,
      ).run(
        allocation.sourceId,
        processingGeneration,
        allocation.policyRevision,
        allocation.inputDigest ?? null,
        allocation.createdAt.toISOString(),
      );
      return processingGeneration;
    })
    .immediate();
}

/**
 * Makes an allocated generation the active one, replacing whichever generation held that place,
 * and publishes the readiness revision for the inventory that becomes live with it. All of it is
 * one transaction, so the store never sees two active generations, never sees a source with
 * none between them, and never sees the inventory live at a revision nobody published.
 *
 * This is the acknowledgment step of the prepare-then-activate sequence: the rows were written
 * while the generation was allocated, and nothing could run them until now.
 *
 * Returns the published readiness revision.
 */
export function activateProcessingGeneration(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
): number {
  return db
    .transaction((): number => {
      db.prepare(
        `UPDATE source_processing_generations SET state = 'replaced'
         WHERE source_id = ? AND state = 'active' AND processing_generation != ?`,
      ).run(sourceId, processingGeneration);
      const promoted = db
        .prepare(
          `UPDATE source_processing_generations SET state = 'active'
           WHERE source_id = ? AND processing_generation = ? AND state IN ('allocated','active')`,
        )
        .run(sourceId, processingGeneration);
      if (promoted.changes !== 1) {
        throw new Error(
          `generation ${processingGeneration} of source ${sourceId} cannot become active`,
        );
      }
      const published = advanceOperationalRevision(db, sourceId, processingGeneration);
      if (published === undefined) {
        throw new Error(
          `generation ${processingGeneration} of source ${sourceId} could not publish its readiness revision`,
        );
      }
      return published;
    })
    .immediate();
}

/**
 * Advances the counter for the named generation, and only while that generation is the active
 * one. Returns the new value, or undefined when the generation has been replaced: an old
 * generation's late completion can neither advance the counter nor discharge the replacement's
 * work.
 */
export function advanceOperationalRevision(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
): number | undefined {
  const result = db
    .prepare(
      `UPDATE source_processing_generations
       SET operational_revision = operational_revision + 1
       WHERE source_id = ? AND processing_generation = ? AND state = 'active'`,
    )
    .run(sourceId, processingGeneration);
  if (result.changes !== 1) {
    return undefined;
  }
  return readGeneration(db, sourceId, processingGeneration)?.operationalRevision;
}

export type SourceWorkInput = {
  readonly workId: string;
  readonly sourceId: string;
  readonly processingGeneration: number;
  readonly kind: string;
  /** Required when the kind is 'stage': a stage row that does not name its stage owes nothing. */
  readonly stageName?: string;
  readonly workKey: string;
  readonly dueAt: Date;
  readonly inputRevisionJson?: string;
  readonly capabilityRevision?: number;
};

/**
 * Creates a work row and advances the counter in the same transaction. Owing a new piece of
 * work invalidates a readiness proof made before it, so the two cannot be separate writes: a
 * proof taken between them would read a settled generation that already owes more.
 *
 * Returns the counter's new value, or undefined when the generation is no longer active, in
 * which case nothing was written at all.
 */
export function createSourceWork(db: SqliteHandle, work: SourceWorkInput): number | undefined {
  return db
    .transaction((): number | undefined => {
      const advanced = advanceOperationalRevision(db, work.sourceId, work.processingGeneration);
      if (advanced === undefined) {
        return undefined;
      }
      db.prepare(
        `INSERT INTO source_work
           (work_id, source_id, processing_generation, kind, stage_name, work_key, state,
            input_revision_json, capability_revision, due_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        work.workId,
        work.sourceId,
        work.processingGeneration,
        work.kind,
        work.stageName ?? null,
        work.workKey,
        work.inputRevisionJson ?? null,
        work.capabilityRevision ?? null,
        work.dueAt.toISOString(),
      );
      return advanced;
    })
    .immediate();
}

/**
 * One obligation on a generation that is not yet live, written the way the stage skeleton is.
 * `createSourceWork` above requires an active generation because owing new work to a live one
 * invalidates a readiness proof; a generation still being prepared has no proof to invalidate,
 * and waiting for activation would leave the window this exists to close. Returns the readiness
 * revision, or undefined when the generation is replaced or absent and nothing was written.
 */
export function prepareGenerationWork(db: SqliteHandle, work: SourceWorkInput): number | undefined {
  return db
    .transaction((): number | undefined => {
      const current = readGeneration(db, work.sourceId, work.processingGeneration);
      if (current === undefined || current.state === 'replaced') {
        return undefined;
      }
      const advanced =
        current.state === 'active'
          ? advanceOperationalRevision(db, work.sourceId, work.processingGeneration)
          : current.operationalRevision;
      db.prepare(
        `INSERT INTO source_work
           (work_id, source_id, processing_generation, kind, stage_name, work_key, state,
            input_revision_json, capability_revision, due_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (source_id, processing_generation, kind, work_key) DO NOTHING`,
      ).run(
        work.workId,
        work.sourceId,
        work.processingGeneration,
        work.kind,
        work.stageName ?? null,
        work.workKey,
        work.inputRevisionJson ?? null,
        work.capabilityRevision ?? null,
        work.dueAt.toISOString(),
      );
      return advanced;
    })
    .immediate();
}

/** The work id a stage row gets, so a restart writes the same row rather than a second one. */
export function stageWorkId(
  sourceId: string,
  processingGeneration: number,
  stageName: string,
): string {
  return `stage:${sourceId}:${processingGeneration}:${stageName}`;
}

export type InventorySkeleton = {
  readonly sourceId: string;
  readonly processingGeneration: number;
  /** Every stage the policy requires. A stage with no row would be measured as no work at all. */
  readonly stageNames: readonly string[];
  readonly dueAt: Date;
};

/**
 * Writes a row for every stage the generation owes. An allocated generation is the ordinary
 * case: the rows are durable before the generation is activated, and nothing runs them until
 * activation publishes the inventory. A generation that is already active takes new stages the
 * same way, and those advance the counter, because a stage added after a readiness proof was
 * made invalidates it.
 *
 * Stages that already have a row are left alone, so a repeated preparation writes nothing and
 * advances nothing. A replaced generation gets no rows at all: its inventory is over.
 *
 * Returns the generation's readiness revision after the write, or undefined when the generation
 * is replaced or absent.
 */
export function prepareInventorySkeleton(
  db: SqliteHandle,
  skeleton: InventorySkeleton,
): number | undefined {
  return db
    .transaction((): number | undefined => {
      const existing = new Set(
        listStageWork(db, skeleton.sourceId, skeleton.processingGeneration).map(
          (row) => row.stageName,
        ),
      );
      const missing = skeleton.stageNames.filter((name) => !existing.has(name));
      const current = readGeneration(db, skeleton.sourceId, skeleton.processingGeneration);
      if (current === undefined || current.state === 'replaced') {
        return undefined;
      }
      if (missing.length === 0) {
        return current.operationalRevision;
      }

      const advanced =
        current.state === 'active'
          ? advanceOperationalRevision(db, skeleton.sourceId, skeleton.processingGeneration)
          : current.operationalRevision;
      const statement = db.prepare(
        `INSERT INTO source_work
           (work_id, source_id, processing_generation, kind, stage_name, work_key, state, due_at)
         VALUES (?, ?, ?, 'stage', ?, ?, 'pending', ?)`,
      );
      for (const stageName of missing) {
        statement.run(
          stageWorkId(skeleton.sourceId, skeleton.processingGeneration, stageName),
          skeleton.sourceId,
          skeleton.processingGeneration,
          stageName,
          `stage:${stageName}`,
          skeleton.dueAt.toISOString(),
        );
      }
      return advanced;
    })
    .immediate();
}

/**
 * The typed outcome a completed stage carries. A stage that does not apply says so and says
 * why, so a reader can tell "this was done" from "this was never going to happen" without
 * inferring either from a missing row.
 */
export type StageOutcome = {
  readonly outcome: 'complete' | 'not_applicable';
  readonly reason: string;
  /** The prerequisite this outcome rests on, when it rests on one. */
  readonly proof?: Record<string, unknown>;
};

/**
 * Completes one piece of work with its outcome. The outcome is required and is stored as
 * given, because inventory completeness is decided by reading outcomes and never by counting
 * rows: a row with no outcome says nothing about whether its stage happened.
 */
export function completeSourceWork(
  db: SqliteHandle,
  workId: string,
  outcome: StageOutcome,
  completedAt: Date,
): number | undefined {
  if (outcome.reason.length === 0) {
    throw new Error(`work ${workId} completed with an empty reason`);
  }
  return db
    .transaction((): number | undefined => {
      const row = db
        .prepare(
          'SELECT source_id, processing_generation, state FROM source_work WHERE work_id = ?',
        )
        .get(workId) as
        { source_id: string; processing_generation: number; state: string } | undefined;
      if (row === undefined) {
        throw new Error(`work ${workId} does not exist`);
      }
      if (row.state === 'completed') {
        return readGeneration(db, row.source_id, row.processing_generation)?.operationalRevision;
      }

      const advanced = advanceOperationalRevision(db, row.source_id, row.processing_generation);
      if (advanced === undefined) {
        return undefined;
      }
      db.prepare(
        `UPDATE source_work SET state = 'completed', outcome_json = ?, completed_at = ?
         WHERE work_id = ?`,
      ).run(JSON.stringify(outcome), completedAt.toISOString(), workId);
      return advanced;
    })
    .immediate();
}

export type OutstandingWorkRow = {
  readonly workId: string;
  readonly sourceId: string;
  readonly processingGeneration: number;
  readonly kind: string;
  readonly stageName: string | null;
  readonly workKey: string;
  readonly state: string;
  readonly dueAt: string;
};

/**
 * Work whose generation is active and whose due time has arrived, in the keyset order the index
 * holds. A runner pages on the last row it saw rather than an offset, so a restart mid-backlog
 * costs nothing.
 *
 * The generation test is part of the WHERE clause rather than a filter over the returned page,
 * so a source with a large prepared-but-inactive inventory cannot fill the page and starve work
 * that is actually runnable. Rows belonging to a generation that was replaced stay where they
 * are and simply stop being nominated: marking them obsolete and settling what they already
 * produced is a separate obligation, and dropping them from this read does not discharge it.
 */
export function listOutstandingWork(
  db: SqliteHandle,
  dueBy: Date,
  limit: number,
  cursor?: { dueAt: string; sourceId: string; workId: string },
): readonly OutstandingWorkRow[] {
  const keyset = cursor === undefined ? '' : `AND (w.due_at, w.source_id, w.work_id) > (?, ?, ?)`;
  const parameters =
    cursor === undefined
      ? [dueBy.toISOString(), limit]
      : [dueBy.toISOString(), cursor.dueAt, cursor.sourceId, cursor.workId, limit];
  const rows = db
    .prepare(
      `SELECT w.work_id, w.source_id, w.processing_generation, w.kind, w.stage_name, w.work_key,
              w.state, w.due_at
       FROM source_work w
       WHERE w.state IN ('pending','retryable','transferred') AND w.due_at <= ? ${keyset}
         AND EXISTS (SELECT 1 FROM source_processing_generations g
                     WHERE g.source_id = w.source_id
                       AND g.processing_generation = w.processing_generation
                       AND g.state = 'active')
       ORDER BY w.due_at, w.source_id, w.work_id
       LIMIT ?`,
    )
    .all(...parameters) as {
    work_id: string;
    source_id: string;
    processing_generation: number;
    kind: string;
    stage_name: string | null;
    work_key: string;
    state: string;
    due_at: string;
  }[];
  return rows.map((row) => ({
    workId: row.work_id,
    sourceId: row.source_id,
    processingGeneration: row.processing_generation,
    kind: row.kind,
    stageName: row.stage_name,
    workKey: row.work_key,
    state: row.state,
    dueAt: row.due_at,
  }));
}

/** The stage rows a generation owes, and the outcome each carries so far. */
export function listStageWork(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
): readonly { stageName: string; state: string; outcome: StageOutcome | undefined }[] {
  const rows = db
    .prepare(
      `SELECT stage_name, state, outcome_json FROM source_work
       WHERE source_id = ? AND processing_generation = ? AND kind = 'stage'
       ORDER BY stage_name`,
    )
    .all(sourceId, processingGeneration) as {
    stage_name: string;
    state: string;
    outcome_json: string | null;
  }[];
  return rows.map((row) => ({
    stageName: row.stage_name,
    state: row.state,
    outcome: row.outcome_json === null ? undefined : (JSON.parse(row.outcome_json) as StageOutcome),
  }));
}
