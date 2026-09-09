import { z } from 'zod';

import { EvidenceAddressSchema } from '../../evidence/domain/address.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';

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
  /**
   * What the work is about, in the shape a rebuild reads it back through. Validated rather than
   * counted: an array with a null in it says a row carries an address and names nothing.
   */
  addresses: z.array(EvidenceAddressSchema).min(1),
  idempotencyKey: z.string().min(1),
});

/**
 * The evidence a transferred row was measured against, whole.
 *
 * The digest is recomputed from the dependencies rather than trusted, because a stored revision
 * whose digest does not follow from its own dependency set is a record of nothing: it cannot say
 * what a later reader would have to compare against.
 */
export const TransferEvidenceSchema = z
  .object({
    contractVersion: z.literal(1),
    dependencies: z.array(
      z.object({
        kind: z.enum(['source', 'node', 'relation_scope']),
        id: z.string().min(1),
        scope: z.string().min(1),
        version: z.string().min(1),
      }),
    ),
    digest: z.string().min(1),
  })
  .refine(
    (value) => buildEvidenceRevision(value.dependencies).digest === value.digest,
    'the recorded digest does not follow from the recorded dependencies',
  );
