import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';
import { ReflectionLaneSchema } from './reflection-input.js';

/**
 * How many turns and tool executions a birth fence trimmed, or fully refused: the entries a
 * push carried whose own timestamp read before the substrate's birth. Absent from an ack, or
 * zero, is what every push from an already-established, cursor-tracking session looks like.
 */
export const PreBirthCountsSchema = z.strictObject({
  turns: z.number().int().nonnegative(),
  tool_executions: z.number().int().nonnegative(),
});

export type PreBirthCounts = z.infer<typeof PreBirthCountsSchema>;

/**
 * Intake always returns `queued: true`. A `literal` rather than `boolean` keeps that
 * pinned in the type, since intake never reports synchronous completion.
 *
 * `lane` is the lane the episode was actually enqueued in, which is not always the one
 * the caller asked for. It is how a client learns the backstop demoted it, and the only
 * signal that its own memory is now queued behind live traffic.
 *
 * `pending_ahead` is how many unclaimed interactive-lane jobs sat ahead of this one at
 * enqueue time (the ack always said `queued: true` with no sense of how far behind
 * that queue actually was). Optional so an ack from a build that predates it still parses.
 *
 * `pre_birth_trim` is present only when the birth fence cut part of this push before storing
 * the rest: a client that reads only `structuredContent` still learns its push was cut down,
 * rather than reading a duplicate-looking ack for content that landed nowhere.
 */
export const ReflectionOutputSchema = z.strictObject({
  episode_id: z.string().min(1),
  queued: z.literal(true),
  lane: ReflectionLaneSchema,
  pending_ahead: z.number().int().nonnegative().optional(),
  pre_birth_trim: PreBirthCountsSchema.optional(),
});

export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;

/**
 * The other answer intake can give: every turn and tool execution this push carried read, by
 * its own timestamp, before the substrate's birth. Nothing was stored and nothing was queued,
 * and this names why rather than a client reading a normal-looking ack for a push that landed
 * nowhere. `status` is what tells the two branches apart, the same way `RecallRefusalSchema`
 * carries it and `MemoryPackSchema` does not.
 */
export const ReflectionRefusalSchema = z.strictObject({
  status: z.literal('pre_birth_refusal'),
  substrate_born_at: IsoTimestampSchema,
  pre_birth_refused: PreBirthCountsSchema,
});

export type ReflectionRefusal = z.infer<typeof ReflectionRefusalSchema>;

export const ReflectionResultSchema = z.union([ReflectionOutputSchema, ReflectionRefusalSchema]);

export type ReflectionResult = z.infer<typeof ReflectionResultSchema>;

/** Whether an answer is the refusal branch, for a consumer that has not parsed it yet. */
export function isReflectionRefusal(result: ReflectionResult): result is ReflectionRefusal {
  return 'status' in result;
}
