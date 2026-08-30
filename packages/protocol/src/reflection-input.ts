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

const ReflectionPayloadSchema = z.strictObject({
  turns: z.array(ReflectionTurnSchema).optional(),
  tool_executions: z.array(ToolExecutionSchema).optional(),
  observations: z.array(ObservationSchema).optional(),
  summary: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  lane: ReflectionLaneSchema.optional(),
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
