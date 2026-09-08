/** Doubling from the first failure, never past the configured cap. */
export function backoffDelayMs(attempts: number, baseMs: number, capMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(baseMs * 2 ** exponent, capMs);
}
