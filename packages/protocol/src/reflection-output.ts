import { z } from 'zod';

/**
 * PRD §3.2: intake always returns `queued: true`; a `literal` rather than `boolean` keeps
 * that pinned in the type, since intake never reports synchronous completion.
 */
export const ReflectionOutputSchema = z.strictObject({
  episode_id: z.string().min(1),
  queued: z.literal(true),
});

export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;
