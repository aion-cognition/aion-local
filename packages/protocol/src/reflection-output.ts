import { z } from 'zod';
import { ReflectionLaneSchema } from './reflection-input.js';

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
 */
export const ReflectionOutputSchema = z.strictObject({
  episode_id: z.string().min(1),
  queued: z.literal(true),
  lane: ReflectionLaneSchema,
  pending_ahead: z.number().int().nonnegative().optional(),
});

export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;
