import type { ExperienceArchiveRow } from '../../infrastructure/sqlite/experience-archive.js';
import type { OpsLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import type { ReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';

/**
 * One episode's life on the substrate, flattened into ordered events instead of the seven
 * separate reads that answer it. Every event carries exactly one clock: `world` for a stamp
 * that came off the payload or a derived node's own timestamp, `tx` for one the substrate
 * minted when it wrote something. Reading the two side by side is the point: a stage applied
 * months after its episode happened is ordinary, a derived node whose world time equals its
 * tx time on a replayed episode is the clock collapse the threading fix closed, made visible
 * without a diff.
 *
 * Pure over whatever the caller already read: nothing here opens a driver or a database
 * handle. The CLI does the seven-source hydration a real episode needs; this file is
 * exercised with fabricated rows.
 */

export type TimelineClockClass = 'world' | 'tx';

export type TimelineEventKind =
  | 'occurred'
  | 'archived'
  | 'stored'
  | 'enqueued'
  | 'completed'
  | 'stage_applied'
  | 'run_applied'
  | 'derived_node';

export type TimelineEvent = {
  readonly kind: TimelineEventKind;
  readonly at: Date;
  readonly clock: TimelineClockClass;
  /** One line, plain enough to read without the detail bag. */
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
};

export type TimelineStageInput = {
  readonly name: string;
  /** Undefined when the stage's ledger key was never marked: it has not run yet, or it failed. */
  readonly entry: OpsLedgerEntry | undefined;
};

export type TimelineDerivedNodeInput = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly occurredAt: Date | undefined;
  readonly txFrom: Date | undefined;
};

export type EpisodeTimelineInput = {
  readonly episodeId: string;
  readonly archive: ExperienceArchiveRow | undefined;
  /** The episode node's own `occurred_at`, read independently of the archive for the cross-check. */
  readonly episodeOccurredAt: Date | undefined;
  readonly episodeValidFrom: Date | undefined;
  readonly episodeTxFrom: Date | undefined;
  /** The queue row naming this episode, or undefined once `claim.ts` deleted it on success. */
  readonly queueJob: ReflectionJob | undefined;
  /** One entry per pipeline stage, in pipeline order, so a tie among them renders in run order. */
  readonly stages: readonly TimelineStageInput[];
  readonly runEntry: OpsLedgerEntry | undefined;
  readonly derivedNodes: readonly TimelineDerivedNodeInput[];
};

/** Render order for events tied on timestamp: the order an undisturbed run produces them in. */
const KIND_ORDER: readonly TimelineEventKind[] = [
  'occurred',
  'archived',
  'stored',
  'enqueued',
  'completed',
  'stage_applied',
  'run_applied',
  'derived_node',
];

function compareEvents(left: TimelineEvent, right: TimelineEvent): number {
  const byTime = left.at.getTime() - right.at.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
}

function occurredEvent(input: EpisodeTimelineInput): TimelineEvent | undefined {
  const { archive } = input;
  if (archive === undefined) {
    return undefined;
  }
  const at = new Date(archive.occurredAt);
  const cross = input.episodeOccurredAt;
  return {
    kind: 'occurred',
    at,
    clock: 'world',
    summary: 'the episode happened',
    detail: {
      episode_occurred_at: cross?.toISOString(),
      matches_episode: cross === undefined ? undefined : cross.getTime() === at.getTime(),
    },
  };
}

function archivedEvent(input: EpisodeTimelineInput): TimelineEvent | undefined {
  const { archive } = input;
  if (archive === undefined) {
    return undefined;
  }
  return {
    kind: 'archived',
    at: new Date(archive.archivedAt),
    clock: 'tx',
    summary: `archived under pipeline ${archive.pipelineVersion}`,
    detail: {
      schema_version: archive.schemaVersion,
      pipeline_version: archive.pipelineVersion,
      content_hash: archive.contentHash,
      lane: archive.lane,
      origin: archive.origin,
    },
  };
}

/**
 * Split into a world-clock and a tx-clock event rather than one event carrying both stamps: a
 * replayed episode is exactly the case where the two drift apart, and one event can only sort
 * into one place in the timeline.
 */
function storedEvents(input: EpisodeTimelineInput): readonly TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (input.episodeValidFrom !== undefined) {
    events.push({
      kind: 'stored',
      at: input.episodeValidFrom,
      clock: 'world',
      summary: 'world stamp on the episode node',
      detail: { valid_from: input.episodeValidFrom.toISOString() },
    });
  }
  if (input.episodeTxFrom !== undefined) {
    events.push({
      kind: 'stored',
      at: input.episodeTxFrom,
      clock: 'tx',
      summary: 'the episode committed to the graph',
      detail: { tx_from: input.episodeTxFrom.toISOString() },
    });
  }
  return events;
}

/**
 * The queue row if one is still there, or the run's own applied stamp when it is not:
 * `claim.ts` deletes the row on success, so its absence after a run that applied is the
 * ordinary case, not a gap the render should apologize for.
 */
function jobEvent(input: EpisodeTimelineInput): TimelineEvent | undefined {
  const job = input.queueJob;
  if (job !== undefined) {
    return {
      kind: 'enqueued',
      at: new Date(job.enqueuedAt),
      clock: 'tx',
      summary: `queued in the ${job.lane} lane`,
      detail: {
        lane: job.lane,
        attempts: job.attempts,
        claimed_at: job.claimedAt,
        claimed_by: job.claimedBy,
        last_error: job.lastError,
      },
    };
  }
  if (input.runEntry !== undefined) {
    return {
      kind: 'completed',
      at: new Date(input.runEntry.appliedAt),
      clock: 'tx',
      summary: 'the job completed; its queue row was cleared',
      detail: {},
    };
  }
  return undefined;
}

type StageLedgerText = { readonly status: string | undefined; readonly text: string | undefined };

/** The per-stage ledger writes `{ status, summary }` (orchestrator.ts); read it back the same shape. */
function stageLedgerText(value: unknown): StageLedgerText {
  if (value === null || typeof value !== 'object') {
    return { status: undefined, text: undefined };
  }
  const row = value as Record<string, unknown>;
  return {
    status: typeof row.status === 'string' ? row.status : undefined,
    text: typeof row.summary === 'string' ? row.summary : undefined,
  };
}

function stageEvents(input: EpisodeTimelineInput): readonly TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const stage of input.stages) {
    const { entry } = stage;
    if (entry === undefined) {
      continue;
    }
    const { status, text } = stageLedgerText(entry.summary);
    events.push({
      kind: 'stage_applied',
      at: new Date(entry.appliedAt),
      clock: 'tx',
      summary: `stage ${stage.name} applied${status === undefined ? '' : ` (${status})`}`,
      detail: { stage: stage.name, status, text },
    });
  }
  return events;
}

/** The run-level ledger writes a full `ReflectionSummary` (stage.ts); pull the duration out for the one-liner. */
function runDurationMs(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  return typeof row.durationMs === 'number' ? row.durationMs : undefined;
}

function runEvent(input: EpisodeTimelineInput): TimelineEvent | undefined {
  const entry = input.runEntry;
  if (entry === undefined) {
    return undefined;
  }
  const durationMs = runDurationMs(entry.summary);
  return {
    kind: 'run_applied',
    at: new Date(entry.appliedAt),
    clock: 'tx',
    summary:
      durationMs === undefined ? 'the run applied' : `the run applied in ${String(durationMs)}ms`,
    detail: { summary: entry.summary },
  };
}

function derivedNodeEvents(input: EpisodeTimelineInput): readonly TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const node of input.derivedNodes) {
    const label = node.labels[0] ?? 'node';
    const detail = { node_id: node.id, labels: node.labels };
    if (node.occurredAt !== undefined) {
      events.push({
        kind: 'derived_node',
        at: node.occurredAt,
        clock: 'world',
        summary: `${label} ${node.id} derived from this episode`,
        detail,
      });
    }
    if (node.txFrom !== undefined) {
      events.push({
        kind: 'derived_node',
        at: node.txFrom,
        clock: 'tx',
        summary: `${label} ${node.id} written to the graph`,
        detail,
      });
    }
  }
  return events;
}

/**
 * One episode's timeline, oldest first. Timestamps that tie sort by the order events happen in
 * a run with no clock drift at all (occurred, archived, stored, enqueued, per stage, the run,
 * then whatever it derived), so an undisturbed episode reads top to bottom as its own story and
 * a disturbed one reads as the place the order breaks.
 */
export function buildEpisodeTimeline(input: EpisodeTimelineInput): readonly TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const occurred = occurredEvent(input);
  if (occurred !== undefined) {
    events.push(occurred);
  }
  const archived = archivedEvent(input);
  if (archived !== undefined) {
    events.push(archived);
  }
  events.push(...storedEvents(input));
  const job = jobEvent(input);
  if (job !== undefined) {
    events.push(job);
  }
  events.push(...stageEvents(input));
  const run = runEvent(input);
  if (run !== undefined) {
    events.push(run);
  }
  events.push(...derivedNodeEvents(input));
  return events.sort(compareEvents);
}
