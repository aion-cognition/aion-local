import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';

/**
 * The example shows only `{ role: "user", text }`. No closed role vocabulary is pinned,
 * so this stays a plain string rather than an enum that could reject a legitimate role
 * (e.g. "system") the spec never ruled out.
 */
export const RecallTurnSchema = z.strictObject({
  role: z.string().min(1),
  text: z.string().min(1),
});

export type RecallTurn = z.infer<typeof RecallTurnSchema>;

export const RecallContextSchema = z.strictObject({
  summary: z.string().min(1).optional(),
  recent_turns: z.array(RecallTurnSchema).optional(),
});

export type RecallContext = z.infer<typeof RecallContextSchema>;

export const RecallBudgetSchema = z.strictObject({
  max_tokens: z.number().int().positive(),
});

export type RecallBudget = z.infer<typeof RecallBudgetSchema>;

/**
 * `query` is the only required field. `as_of` is the world-time read mode; `knew_at` is
 * the system-time one. Both are recall inputs, not mutually exclusive.
 */
export const RecallInputSchema = z.strictObject({
  query: z.string().min(1),
  context: RecallContextSchema.optional(),
  budget: RecallBudgetSchema.optional(),
  session_id: z.string().min(1).optional(),
  as_of: IsoTimestampSchema.optional(),
  knew_at: IsoTimestampSchema.optional(),
});

export type RecallInput = z.infer<typeof RecallInputSchema>;
