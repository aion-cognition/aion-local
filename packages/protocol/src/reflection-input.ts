import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';

/**
 * See recall-input.ts for why role stays a string. `occurred_at` is the per-item timestamp.
 * Intake uses it when the caller supplies it, else the wall clock at write time.
 */
export const ReflectionTurnSchema = z.strictObject({
  role: z.string().min(1),
  text: z.string().min(1),
  occurred_at: IsoTimestampSchema.optional(),
});

export type ReflectionTurn = z.infer<typeof ReflectionTurnSchema>;

/**
 * No closed vocabulary is pinned on `status`, so it stays a string for the same reason
 * `role` does. `input` and `output` are whatever the tool call actually carried (string
 * or structured). Redaction walks either shape.
 *
 * Only `tool` and `status` are required. Nothing inside a tool execution is mandated.
 * The at-least-one-of rule is across `turns`, `tool_executions`, and `observations`.
 * An agent that captured no output or did not time the call is reporting a real execution.
 * `.optional()` is load-bearing on the `unknown` fields: in zod v4 a bare `z.unknown()`
 * in an object is a required key, so omitting `output` would be rejected outright.
 */
export const ToolExecutionSchema = z.strictObject({
  tool: z.string().min(1),
  input: z.unknown().optional(),
  status: z.string().min(1),
  output: z.unknown().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  occurred_at: IsoTimestampSchema.optional(),
});

export type ToolExecution = z.infer<typeof ToolExecutionSchema>;

export const ObservationSchema = z.string().min(1);

/**
 * The service class the episode is enqueued in. Optional and backward compatible. A
 * payload that says nothing is interactive, which is the freshness pin's default.
 *
 * `bulk` is taken at face value. A caller importing a backlog can say so and stop
 * competing with live turns. `interactive` is a preference rather than a guarantee.
 * Intake's arrival-rate backstop still demotes a client that floods, since a flag any
 * client can assert on every push cannot also be the thing that exempts it.
 */
export const ReflectionLaneSchema = z
  .enum(['interactive', 'bulk'])
  .describe('bulk queues this episode behind live turns; omit for interactive');

/**
 * Record-only provenance: how the reflection call reached intake. It never gates a
 * dismissal or any other policy decision, so a caller-settable field is not a trust hole.
 * `event` names the hook event or transport call that pushed the payload; a caller that
 * does not know one omits it.
 *
 * `system` is the substrate writing about itself: an init, a replay, a model swap. Nobody
 * sat at a keyboard for one, so it is a channel rather than a call the member made.
 */
export const ReflectionOriginSchema = z.strictObject({
  channel: z.enum(['hook', 'mcp', 'cli', 'system']),
  event: z.string().optional(),
});

export type ReflectionOrigin = z.infer<typeof ReflectionOriginSchema>;

/** How many references of one kind a single call may carry, so one payload cannot fan out. */
export const MAX_PROVENANCE_REFERENCES = 16;

/**
 * A confirmation the caller states outright: who confirmed the target, and where that is
 * written down. The reference is what makes it attributable, since a transport role names no
 * person and agent-to-agent traffic arrives under `user`.
 *
 * It is recorded and rendered, and it decides nothing. No stage waits on one, no closure
 * follows from one, and an absent confirmation is not a rejection.
 */
export const ConfirmationRecordSchema = z.strictObject({
  /** The node the confirmation is about. Validated against the substrate; unknown ids are dropped. */
  target: z.string().min(1),
  /** Who confirmed it. Free text, because the substrate holds no roster to check it against. */
  by: z.string().min(1),
  /** Where the confirmation is recorded, so a pack cites a reference rather than asserting one. */
  evidence: z.string().min(1),
  occurred_at: IsoTimestampSchema.optional(),
});

export type ConfirmationRecord = z.infer<typeof ConfirmationRecordSchema>;

/**
 * The two reference kinds a caller may state, kept apart because they mean different things.
 *
 * `supersedes` says this experience corrects those nodes. It routes straight to lineage as a
 * stated correction and closes nothing: the named node keeps its currency, and only the
 * supersession judge closes anything.
 *
 * `derived_from` says this experience descends from those nodes. It marks a source, asserts no
 * disagreement, and is what keeps two claims that share a root from reading as two witnesses.
 *
 * Both are validated against the substrate. A reference to something the substrate does not
 * hold is dropped and counted, and the episode's lineage is marked incomplete rather than
 * padded with an id nothing backs.
 */
export const ReflectionProvenanceSchema = z.strictObject({
  supersedes: z
    .array(z.string().min(1))
    .max(MAX_PROVENANCE_REFERENCES)
    .optional()
    .describe('ids this experience corrects; recorded as a stated correction, closes nothing'),
  derived_from: z
    .array(z.string().min(1))
    .max(MAX_PROVENANCE_REFERENCES)
    .optional()
    .describe('ids this experience came from, so two claims sharing a source say so'),
  confirmations: z
    .array(ConfirmationRecordSchema)
    .max(MAX_PROVENANCE_REFERENCES)
    .optional()
    .describe('who confirmed a stored memory and where that is written down'),
});

export type ReflectionProvenance = z.infer<typeof ReflectionProvenanceSchema>;

/**
 * One thing a caller says about memories it was served.
 *
 * `reporter` is who the report is filed under. It never establishes who filed it: a transport
 * role names no person and agent-to-agent traffic arrives under `user`, so a report of this
 * shape is a self-report whatever the field says. `evidence` is where it is written down, when
 * there is anywhere to point at.
 */
export const FeedbackReportSchema = z.strictObject({
  memories: z.array(z.string().min(1)).min(1).max(MAX_PROVENANCE_REFERENCES),
  reporter: z.string().min(1),
  evidence: z.string().min(1).optional(),
  occurred_at: IsoTimestampSchema.optional(),
});

export type FeedbackReport = z.infer<typeof FeedbackReportSchema>;

/**
 * What became of a pack, told by the only party that can tell it.
 *
 * `received` says a pack arrived. Assembling one proves nothing about that, so without a caller
 * saying so the substrate knows only what it put on the wire. `used` says the caller acted on
 * the named memories. The two are apart because delivery is not use, and neither is truth:
 * confirming a memory is a different statement and goes in `provenance.confirmations`, which
 * requires a reference.
 *
 * Recorded and nothing more. No stage waits on one, no weight moves for one, and a pack nobody
 * reported on is not a pack that went unread.
 */
export const RecallFeedbackSchema = z.strictObject({
  received: z
    .array(FeedbackReportSchema)
    .max(MAX_PROVENANCE_REFERENCES)
    .optional()
    .describe('memories that reached this caller, which server-side assembly cannot establish'),
  used: z
    .array(FeedbackReportSchema)
    .max(MAX_PROVENANCE_REFERENCES)
    .optional()
    .describe('memories this caller acted on; recorded as its own report, never as confirmation'),
});

export type RecallFeedback = z.infer<typeof RecallFeedbackSchema>;

const ReflectionPayloadSchema = z.strictObject({
  turns: z.array(ReflectionTurnSchema).optional(),
  tool_executions: z.array(ToolExecutionSchema).optional(),
  observations: z.array(ObservationSchema).optional(),
  summary: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  lane: ReflectionLaneSchema.optional(),
  origin: ReflectionOriginSchema.optional(),
  provenance: ReflectionProvenanceSchema.optional(),
  feedback: RecallFeedbackSchema.optional(),
});

/**
 * At least one of `turns`, `tool_executions`, or `observations` must carry an entry.
 * A payload of only `summary` and `session_id` is not experience to store.
 */
export const ReflectionInputSchema = ReflectionPayloadSchema.refine(
  (payload) =>
    (payload.turns?.length ?? 0) > 0 ||
    (payload.tool_executions?.length ?? 0) > 0 ||
    (payload.observations?.length ?? 0) > 0,
  { message: 'reflection requires at least one of: turns, tool_executions, observations' },
);

export type ReflectionInput = z.infer<typeof ReflectionInputSchema>;
