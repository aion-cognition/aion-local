import { z } from 'zod';

/**
 * What a work row's continuation says about the work it still owes.
 *
 * Two readings, both validated rather than duck-typed. A row's continuation is written by
 * whatever left the work behind, and a reader that inferred an effect or a transfer from the
 * presence of a field would be reading a shape somebody happened to write.
 */

/** A row that names the effect its remaining work would have, for callers classifying it. */
export const ContinuationEffectSchema = z.object({ effect: z.string().min(1) });

/**
 * A row handed to another runner: who runs it, under which contract, about what, and under which
 * identity so it runs exactly once. All of it, because a transfer missing any of it is a row
 * somebody moved rather than work somebody can pick up.
 */
export const TransferContinuationSchema = z.object({
  runner: z.string().min(1),
  runnerRevision: z.number().int().nonnegative(),
  addresses: z.array(z.unknown()).min(1),
  idempotencyKey: z.string().min(1),
});
