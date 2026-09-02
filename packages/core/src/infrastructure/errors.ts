import type { z } from 'zod';

/**
 * The one place an error is turned into text, so no layer writes its own and drops the name.
 *
 * Two renderings, deliberately both: `describeError` keeps the name, because
 * `OllamaUnreachableError` is most of what a reader needs; `errorMessage` drops it where the
 * message alone is the whole field, as in the reflection queue's `last_error`.
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
