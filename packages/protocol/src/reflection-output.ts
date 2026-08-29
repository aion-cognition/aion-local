import { z } from 'zod';
import { ReflectionLaneSchema } from './reflection-input.js';

/**
 * PRD §3.2: intake always returns `queued: true`; a `literal` rather than `boolean` keeps
 * that pinned in the type, since intake never reports synchronous completion.
 *
 * `lane` is the lane the episode was actually enqueued in, which is not always the one the
 * caller asked for: it is how a client learns the backstop demoted it, and the only signal
 * that its own memory is now queued behind live traffic.
 */
export const ReflectionOutputSchema = z.strictObject({
  episode_id: z.string().min(1),
  queued: z.literal(true),
  lane: ReflectionLaneSchema,
});

export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;
