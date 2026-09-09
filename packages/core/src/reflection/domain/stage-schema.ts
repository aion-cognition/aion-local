import { z } from 'zod';

import { STAGE_SETTLEMENT_REASONS } from './stage.js';
import { SOURCE_PART_KINDS } from '../../evidence/domain/address.js';

/**
 * What a stage reported, as a wire and storage shape.
 *
 * One definition for both readers. A completion payload and a recovered ledger entry describe the
 * same thing, and two schemas for it would let a field travel through one and be dropped by the
 * other, which is how a remainder disappears between a crash and the retry that answers for it.
 */

export const StageSettlementSchema = z.strictObject({
  disposition: z.enum(['complete', 'not_applicable']),
  reason: z.enum(STAGE_SETTLEMENT_REASONS),
  proof: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const Dependency = z.strictObject({
  kind: z.enum(['source', 'node', 'relation_scope']),
  id: z.string().min(1),
  scope: z.string().min(1),
  version: z.string().min(1),
});

/**
 * A judgment the pass could not decide, with what it was about and what it was judged against.
 *
 * It travels whole. The nodes name the pair, the addresses name the parts a rebuild reads it back
 * through, and the revision is the evidence the abstention rested on; a record carrying only a
 * count closes a row over work nobody can find again.
 */
export const WithheldWorkSchema = z.strictObject({
  nodeIds: z.array(z.string().min(1)),
  disposition: z.enum(['blocked', 'retryable']),
  reason: z.string(),
  addresses: z.array(
    z.union([
      z.strictObject({ kind: z.literal('id'), id: z.string().min(1) }),
      z.strictObject({
        kind: z.literal('part'),
        sourceId: z.string().min(1),
        partKind: z.enum(SOURCE_PART_KINDS),
        ordinal: z.number().int().nonnegative(),
      }),
    ]),
  ),
  revision: z.strictObject({
    contractVersion: z.literal(1),
    dependencies: z.array(Dependency),
    digest: z.string(),
  }),
});

/**
 * What a recorded outcome was produced under.
 *
 * A ledger entry is a statement about obligations, and obligations belong to a generation. An
 * entry recorded under one generation says nothing about the pass a replacement owes, so the
 * binding travels with the entry and a reader reuses the outcome only while it still applies.
 */
export const StageBindingSchema = z.strictObject({
  processingGeneration: z.number().int().nonnegative(),
  operationalRevision: z.number().int().nonnegative(),
  /**
   * What each stage row owed when the run started, by stage name.
   *
   * The generation alone is too coarse and the readiness counter is too fine. The counter moves
   * for every settlement the run itself makes, so comparing it would re-enter every stage on
   * every ordinary retry; the generation misses work that landed on a row inside one. What a
   * recorded pass answers for is the work its own row held when it started, so that is what the
   * entry carries and what a later attempt compares.
   */
  work: z.record(z.string(), z.string()),
});

export type StageBinding = z.infer<typeof StageBindingSchema>;

const stageReport = {
  name: z.string().min(1),
  status: z.enum(['ok', 'failed', 'skipped']),
  summary: z.string(),
  /** The pass asked to be re-entered. It settles nothing whatever else it wrote. */
  retryable: z.boolean().optional(),
  withheldWork: z.array(WithheldWorkSchema).optional(),
  settled: StageSettlementSchema.optional(),
  settledOnUpstream: StageSettlementSchema.optional(),
};

/** The wire shape, which refuses a field it does not know. */
export const StageReportSchema = z.strictObject(stageReport);

export type StageReport = z.infer<typeof StageReportSchema>;

/**
 * The stored shape, which keeps what it knows and drops the rest.
 *
 * A ledger entry is a record somebody wrote, not a message this build negotiated: it carries the
 * timings and counts the run logged beside the disposition, and a later build may add more.
 * Refusing it over an unknown field would throw away the outcomes a recovery needs.
 */
const StoredStageSchema = z.object({ ...stageReport, binding: StageBindingSchema.optional() });

/**
 * What one stage's ledger entry holds, so a later attempt reads back the disposition rather than
 * the prose. An entry a build wrote before the typed fields existed parses to status and summary
 * alone, with no binding: it settles nothing and leaves the row owed with its reason recorded.
 */
export const StageLedgerEntrySchema = StoredStageSchema.omit({ name: true });

/**
 * What a run's ledger entry holds. It is the run's own summary, so an attempt that finds the key
 * already written can answer with the outcomes the earlier attempt recorded rather than with
 * nothing.
 */
export const RunLedgerEntrySchema = z.object({
  episodeId: z.string().min(1),
  stages: z.array(StoredStageSchema),
  binding: StageBindingSchema.optional(),
});
