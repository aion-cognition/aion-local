/**
 * The correction that did not correct anything, as a fixture.
 *
 * Measured live: the judged claim closed, the proposal resolved, a lineage edge was written,
 * and the next recall still answered with the old owner at rank 1 marked current. The stale
 * ownership sat in three places at once and the apply reached one of them. The observation is
 * written to reproduce that spread: an entity description written the first time the pipeline
 * saw the name, a standing claim about who owns the thing, and a record of how they came to.
 */

export type GranularityFixture = {
  readonly session: string;
  /** Stored first, enriched, and left to answer as current. */
  readonly baseline: readonly string[];
  readonly baselineSummary: string;
  /** Stored second: the correction the review path is supposed to propagate. */
  readonly correction: readonly string[];
  readonly correctionSummary: string;
  readonly query: string;
  /** The name that must stop answering as current. */
  readonly staleOwner: string;
  /** The name the pack has to lead with afterwards. */
  readonly currentOwner: string;
  /** The subject both owners are claimed about. */
  readonly subject: string;
};

export const OWNERSHIP_CORRECTION: GranularityFixture = {
  session: 'gate-granularity-ownership',
  baseline: [
    'Dmitri Volkov owns the Quillon ingest pipeline.',
    'Dmitri Volkov took over the Quillon ingest pipeline from the platform team in March.',
    'The Quillon ingest pipeline moves clinical claim files into the warehouse every night.',
  ],
  baselineSummary: 'who owns the Quillon ingest pipeline, as first recorded',
  correction: [
    'Dmitri Volkov no longer owns the Quillon ingest pipeline.',
    'Anneke Vos owns the Quillon ingest pipeline now.',
  ],
  correctionSummary: 'the Quillon ingest pipeline changed hands',
  query: 'who owns the Quillon ingest pipeline',
  staleOwner: 'Dmitri Volkov',
  currentOwner: 'Anneke Vos',
  subject: 'Quillon ingest pipeline',
};
