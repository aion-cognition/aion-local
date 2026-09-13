import {
  PIPELINE_VERSION,
  type ReplayCursor,
  type ReplayProgress,
  type ReplayReport,
  type UsageReplayProgress,
  type UsageReplayReport,
} from '@aion/core';

import type { Writer } from './output.js';

/**
 * How `aion replay` renders what a pass did, in text and in the JSON envelope.
 *
 * Lifted out of `replay.ts` unchanged when that file reached the 500-line cap. Rendering is the
 * half of the command with no substrate in it: every function here takes a report and a writer
 * and reads nothing.
 */

/** Where a pass stopped, in the terms of whichever population it was walking. */
export function renderCursor(cursor: ReplayCursor): string {
  if (cursor.kind === 'ingest') {
    return `ingest ${String(cursor.position)}`;
  }
  return `${cursor.occurredAt} / ${cursor.id}`;
}

export function renderProgress(progress: ReplayProgress, write: Writer): void {
  write(
    `replayed ${String(progress.replayed)}, skipped ${String(progress.skipped)}, ` +
      `at ${renderCursor(progress.cursor)}`,
  );
}

export function renderReport(report: ReplayReport, write: Writer): void {
  write(`scanned     ${String(report.scanned)}`);
  write(`replayed    ${String(report.replayed)}`);
  write(`skipped     ${String(report.skipped)}`);
  write(`unavailable ${String(report.unavailable)}`);
  write(`evicted     ${String(report.skippedEvicted)}`);
  write(`unrecorded  ${String(report.unrecorded)}`);
  write(`failed      ${String(report.failed)}`);
  if (report.aborted) {
    write(
      report.cursor === undefined
        ? 'aborted before the first batch; nothing was replayed'
        : `aborted at ${renderCursor(report.cursor)}`,
    );
  }
}

/**
 * The cursor in the envelope's own spelling. The discriminant says which population it names;
 * the archive keys keep the `occurred_at` they have always been read under.
 */
export function cursorJson(cursor: ReplayCursor): Record<string, unknown> {
  if (cursor.kind === 'ingest') {
    return { kind: cursor.kind, position: cursor.position };
  }
  return { kind: cursor.kind, occurred_at: cursor.occurredAt, id: cursor.id };
}

export function toJson(report: ReplayReport): unknown {
  return {
    pipeline_version: PIPELINE_VERSION,
    scanned: report.scanned,
    replayed: report.replayed,
    skipped: report.skipped,
    unavailable: report.unavailable,
    skipped_evicted: report.skippedEvicted,
    unrecorded: report.unrecorded,
    failed: report.failed,
    aborted: report.aborted,
    cursor: report.cursor === undefined ? null : cursorJson(report.cursor),
  };
}

export function renderUsageProgress(progress: UsageReplayProgress, write: Writer): void {
  write(
    `applied ${String(progress.scanned - progress.skipped - progress.failed)} of ` +
      `${String(progress.scanned)}, at ${progress.cursor.occurredAt}`,
  );
}

export function renderUsageReport(report: UsageReplayReport, write: Writer): void {
  write(`scanned       ${String(report.scanned)}`);
  write(`access        ${String(report.accessApplied)}`);
  write(
    `reinforcement ${String(report.reinforcementApplied)}, ` +
      `${String(report.edgesReinforced)} edges`,
  );
  write(`decay         ${String(report.decayApplied)}, ${String(report.edgesDecayed)} edges`);
  write(`skipped       ${String(report.skipped)}`);
  write(`failed        ${String(report.failed)}`);
  if (report.aborted) {
    write(
      report.cursor === undefined
        ? 'aborted before the first batch; nothing was applied'
        : `aborted at ${report.cursor.occurredAt} / ${String(report.cursor.id)}`,
    );
  }
}

export function toUsageJson(report: UsageReplayReport): unknown {
  return {
    scanned: report.scanned,
    access_applied: report.accessApplied,
    reinforcement_applied: report.reinforcementApplied,
    edges_reinforced: report.edgesReinforced,
    decay_applied: report.decayApplied,
    edges_decayed: report.edgesDecayed,
    skipped: report.skipped,
    failed: report.failed,
    aborted: report.aborted,
    cursor:
      report.cursor === undefined
        ? null
        : { occurred_at: report.cursor.occurredAt, id: report.cursor.id },
  };
}
