import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';

/**
 * What kind of statement a recalled memory is, and how far it can be traced to anyone.
 *
 * Split out of `recall-output.ts` to keep that file inside the repository's line cap. The two
 * questions travel together because a reader answers them together: a sentence somebody typed and
 * a conclusion the substrate drew over it read alike without both.
 */

/**
 * How the substrate came by the line, so a quotation and an inference never read alike. The last
 * two are inferences over memories rather than readings of a capture.
 */
export const StandingKindSchema = z.enum([
  'recorded_utterance',
  'recorded_session',
  'recorded_decision',
  'extracted_interpretation',
  'synthesized',
  'stated_description',
  'drawn_conclusion',
  'inferred_preference',
]);

export type StandingKind = z.infer<typeof StandingKindSchema>;

/**
 * How far the line can be traced to anyone. A transport role is a label the calling client
 * chose, and agent-to-agent traffic arrives under `user`, so a recorded role is a report and
 * never an identity: it renders as `reported`. `attributed` needs a confirmation record that
 * names who confirmed and cites where the confirmation is written down. Nothing infers either
 * one from a retrieval score.
 */
export const AttributionSchema = z.enum(['unknown', 'reported', 'attributed']);

export type Attribution = z.infer<typeof AttributionSchema>;

/**
 * A confirmation as the substrate holds it: who, when, and the reference the confirmation is
 * recorded under. It is evidence a reader weighs, never a permission the substrate waits on,
 * so nothing in recall or reflection branches on its presence.
 */
export const ConfirmationSchema = z.strictObject({
  by: z.string().min(1),
  at: IsoTimestampSchema,
  evidence: z.string().min(1),
});

export type Confirmation = z.infer<typeof ConfirmationSchema>;

export const StandingSchema = z.strictObject({
  kind: StandingKindSchema,
  /** The role capture recorded, verbatim and uninterpreted. Absent when none was recorded. */
  recorded_role: z.string().min(1).optional(),
  attribution: AttributionSchema,
  /** Present only where a confirmation record names a confirmer and cites its evidence. */
  confirmed: ConfirmationSchema.optional(),
  /**
   * Set on a drawn conclusion the substrate holds a competing reading of. Neither reading is
   * ranked over the other and nothing resolves the contest: both stand, and a reader served one
   * of them without this reads a contested interpretation as the substrate's answer.
   */
  contested: z.literal(true).optional(),
});

export type Standing = z.infer<typeof StandingSchema>;
