import type { z } from 'zod';

/**
 * The error-shaping helpers every layer had written out for itself. They were byte-identical
 * everywhere but one site, and that site had silently dropped the error name, which is where
 * a named failure carries its diagnosis.
 *
 * Two renderings, deliberately both: `describeError` keeps the name, because `OllamaUnreachableError`
 * is most of what a reader needs; `errorMessage` drops it where the message alone is the whole
 * field, as in the reflection queue's `last_error`.
 */

/** A guard aborted the call. The distinction a caller draws is timed out against failed. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** `name: message`, since a named error carries the diagnosis in `name`. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The message alone, for a field whose reader already knows what failed. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every failed path, joined, so a rejected answer says all of what was wrong with it. */
export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

/** Two decimals: a millisecond duration in a log line, not a measurement. */
export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}
