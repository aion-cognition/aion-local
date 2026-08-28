import { z } from 'zod';
import { IsoTimestampSchema } from './common.js';

/**
 * PRD §3.2's example shows only `{ role: "user", text }`; see recall-input.ts for why role
 * stays a string. `occurred_at` is the per-item timestamp: intake uses it when the caller
 * supplies it, else the wall clock at write time.
 */
export const ReflectionTurnSchema = z.strictObject({
  role: z.string().min(1),
  text: z.string().min(1),
  occurred_at: IsoTimestampSchema.optional(),
});

export type ReflectionTurn = z.infer<typeof ReflectionTurnSchema>;

/**
 * PRD §3.2's example shows `status: "error"`; no closed vocabulary is pinned, so this
 * stays a string for the same reason `role` does. `input`/`output` are whatever the tool
 * call actually carried, string or structured — redaction walks either shape.
 *
 * Only `tool` and `status` are required. PRD §3.2 requires nothing inside a tool execution
 * — the at-least-one-of rule is across `turns`/`tool_executions`/`observations` — and an
 * agent that captured no output, or did not time the call, is reporting a real execution.
 * `.optional()` is load-bearing on the `unknown` fields: in zod v4 a bare `z.unknown()` in
 * an object is a required key, so omitting `output` would be rejected outright.
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

const ReflectionPayloadSchema = z.strictObject({
  turns: z.array(ReflectionTurnSchema).optional(),
  tool_executions: z.array(ToolExecutionSchema).optional(),
  observations: z.array(ObservationSchema).optional(),
  summary: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
});

/**
 * PRD §3.2: at least one of `turns`, `tool_executions`, `observations` must carry an
 * entry. A payload of only `summary`/`session_id` is not experience to store.
 */
export const ReflectionInputSchema = ReflectionPayloadSchema.refine(
  (payload) =>
    (payload.turns?.length ?? 0) > 0 ||
    (payload.tool_executions?.length ?? 0) > 0 ||
    (payload.observations?.length ?? 0) > 0,
  { message: 'reflection requires at least one of: turns, tool_executions, observations' },
);

export type ReflectionInput = z.infer<typeof ReflectionInputSchema>;
