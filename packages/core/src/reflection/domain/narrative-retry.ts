/** The first retry delay after a failed attempt; each further attempt doubles it. */
export const SEAL_RETRY_BASE_MS = 15 * 60 * 1000;

/** Where doubling stops, so a chunk that has failed all day is still tried tomorrow. */
export const SEAL_RETRY_CEILING_MS = 6 * 60 * 60 * 1000;

/** Doubling backoff off the attempts the revision row already counts. */
export function sealRetryDelayMs(attempts: number): number {
  const doublings = Math.min(Math.max(0, attempts - 1), 16);
  return Math.min(SEAL_RETRY_CEILING_MS, SEAL_RETRY_BASE_MS * 2 ** doublings);
}

/** Failed migration publications allowed before explicit repair must authorize another attempt window. */
export const MIGRATION_PUBLICATION_FAILURE_LIMIT = 3;
