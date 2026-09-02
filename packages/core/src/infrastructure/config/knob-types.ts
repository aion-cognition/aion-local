import { z } from 'zod';

/**
 * The zod primitives the knob tables share. They live here rather than in `knobs.ts` because the
 * table was split across three files to stay under the 500-line cap, and a validator restated in
 * each of them is a validator three files have to change together.
 *
 * Range constraints match a specific pinned value where one exists; the rest (int/positive/0-1)
 * are defensive shape checks, not tuned limits.
 */
export const proportion = z.number().min(0).max(1);
export const positiveInt = z.number().int().positive();
export const nonNegativeInt = z.number().int().nonnegative();
export const positive = z.number().positive();
export const text = z.string().min(1);
