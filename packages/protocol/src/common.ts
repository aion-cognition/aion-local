import { z } from 'zod';

/**
 * ISO 8601, date-only ("2026-03-01") or full datetime with offset. PRD §3.1's `as_of`/
 * `knew_at` examples are date-only; reflection per-item timestamps may carry
 * time-of-day. Handlers parse this to a `Date` at the substrate boundary; the wire stays
 * a plain string.
 */
export const IsoTimestampSchema = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** PRD §5.5: a node is either the live fact or lineage kept for time-travel. */
export const CurrencySchema = z.enum(['current', 'superseded']);

export type Currency = z.infer<typeof CurrencySchema>;

/** The node that closed this one's validity, and when (PRD §5.5 SUPERSEDES lineage). */
export const SupersededBySchema = z.strictObject({
  id: z.string().min(1),
  at: IsoTimestampSchema,
});

export type SupersededBy = z.infer<typeof SupersededBySchema>;
