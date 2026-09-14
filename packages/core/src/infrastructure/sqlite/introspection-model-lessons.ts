import { createHash } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * What the tier-3 model itself concluded from the introspection senses' evidence, kept apart
 * from `introspection_insights`: that table is the run ledger's own numbers restated and the
 * advisor reads it as a measurement, so a model-authored guess filed there would silently
 * become corroboration for a future prompt rather than staying the interpretation it is.
 *
 * A row here is always linked to the cycle it was drawn on and to a bounded snapshot of the
 * sense evidence the model was shown, so a reader can tell a lesson apart from the raw records
 * it interpreted and go back to them. `operation` is `'none'` for a lesson the model attached to
 * a decline: the model may decline to name work and still offer a lesson, and the two are
 * independent answers.
 */

export type ModelLesson = {
  readonly id: number;
  readonly cycle: number;
  readonly operation: string;
  readonly lesson: string;
  readonly reason: string;
  readonly senseEvidenceDigest: string | undefined;
  /**
   * The evidence lines this lesson was drawn from, as they were shown, bounded by the retention
   * rules below. Absent on a row written before the snapshot existed, or on a cycle with no
   * sense evidence at all; empty is not the same as absent and neither is a lesson without a
   * basis, which is why the digest stays beside it.
   */
  readonly senseEvidence: readonly string[] | undefined;
  readonly recordedAt: string;
};

type ModelLessonRow = {
  id: number;
  cycle: number;
  operation: string;
  lesson: string;
  reason: string;
  sense_evidence_digest: string | null;
  sense_evidence_json: string | null;
  recorded_at: string;
};

/** How many rows the table keeps. A window for the prompt, not the durable record of a cycle. */
export const MODEL_LESSON_RETENTION_ROWS = 200;

/**
 * What one row may retain of the evidence it was drawn from. The snapshot exists so a lesson
 * resolves to what the model read; it is not a second copy of the stream, so it is bounded on
 * both axes and says so in the row when either bound bit.
 */
export const MODEL_LESSON_EVIDENCE_LINES = 12;
export const MODEL_LESSON_EVIDENCE_LINE_CHARS = 400;

/** A stable digest over the evidence lines the model actually saw, for `appendModelLesson`. */
export function senseEvidenceDigest(evidence: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex').slice(0, 16);
}

/**
 * The bounded snapshot. Truncation is stated in the retained text rather than left for a reader
 * to infer from a line that stops mid-sentence, and the digest above is still taken over the
 * whole evidence, so a snapshot that dropped lines cannot pass as the complete basis.
 */
export function boundedSenseEvidence(evidence: readonly string[]): readonly string[] {
  const kept = evidence
    .slice(0, MODEL_LESSON_EVIDENCE_LINES)
    .map((line) =>
      line.length > MODEL_LESSON_EVIDENCE_LINE_CHARS
        ? `${line.slice(0, MODEL_LESSON_EVIDENCE_LINE_CHARS)}... [line truncated at ${String(
            MODEL_LESSON_EVIDENCE_LINE_CHARS,
          )} characters]`
        : line,
    );
  const dropped = evidence.length - kept.length;
  return dropped <= 0
    ? kept
    : [...kept, `... [${String(dropped)} further evidence line(s) not retained on this row]`];
}

export type AppendModelLessonInput = {
  readonly cycle: number;
  readonly operation: string;
  readonly lesson: string;
  readonly reason: string;
  readonly senseEvidence: readonly string[];
  readonly recordedAt?: Date;
};

export function appendModelLesson(db: SqliteHandle, input: AppendModelLessonInput): void {
  const hasEvidence = input.senseEvidence.length > 0;
  const digest = hasEvidence ? senseEvidenceDigest(input.senseEvidence) : null;
  const snapshot = hasEvidence ? JSON.stringify(boundedSenseEvidence(input.senseEvidence)) : null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO introspection_model_lessons
       (cycle, operation, lesson, reason, sense_evidence_digest, sense_evidence_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.cycle,
      input.operation,
      input.lesson,
      input.reason,
      digest,
      snapshot,
      (input.recordedAt ?? new Date()).toISOString(),
    );
    db.prepare(
      `DELETE FROM introspection_model_lessons WHERE id <= (
         SELECT max(id) - ? FROM introspection_model_lessons
       )`,
    ).run(MODEL_LESSON_RETENTION_ROWS);
  })();
}

/** A row whose snapshot will not parse keeps its digest and reports no basis, rather than throwing. */
function readSnapshot(stored: string | null): readonly string[] | undefined {
  if (stored === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((line) => typeof line === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function toModelLesson(row: ModelLessonRow): ModelLesson {
  const senseEvidence = readSnapshot(row.sense_evidence_json);
  return {
    id: row.id,
    cycle: row.cycle,
    operation: row.operation,
    lesson: row.lesson,
    reason: row.reason,
    senseEvidenceDigest: row.sense_evidence_digest ?? undefined,
    senseEvidence,
    recordedAt: row.recorded_at,
  };
}

/** The most recent lessons, oldest first, for the advisor's own prompt on a later cycle. */
export function recentModelLessons(db: SqliteHandle, limit: number): readonly ModelLesson[] {
  const rows = db
    .prepare(
      `SELECT id, cycle, operation, lesson, reason, sense_evidence_digest, sense_evidence_json,
              recorded_at
       FROM introspection_model_lessons
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit) as ModelLessonRow[];
  return rows.map(toModelLesson).reverse();
}
