import { z } from 'zod';

import { CoverageRefusalSchema } from './history-coverage.js';
import { MemoryPackSchema } from './recall-output.js';

/**
 * The two answers a recall can give.
 *
 * The successful one is the MemoryPack it has always been, field for field, so every consumer
 * that parses a pack today parses one tomorrow. A refusal is a branch of its own rather than an
 * empty pack: a request outside the substrate's coverage was not answered, and a pack with no
 * items says the opposite.
 *
 * `status` is what tells them apart. It appears only on the refusal, because adding a
 * discriminator to the pack would change the shape that had to stay unchanged.
 */
export const RecallRefusalSchema = z.strictObject({
  status: z.literal('coverage_refusal'),
  coverage_refusal: CoverageRefusalSchema,
});

export type RecallRefusal = z.infer<typeof RecallRefusalSchema>;

export const RecallResultSchema = z.union([MemoryPackSchema, RecallRefusalSchema]);

export type RecallResult = z.infer<typeof RecallResultSchema>;

/** Whether an answer is the refusal branch, for a consumer that has not parsed it yet. */
export function isRecallRefusal(result: RecallResult): result is RecallRefusal {
  return 'status' in result;
}
