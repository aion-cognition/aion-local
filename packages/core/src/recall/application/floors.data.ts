/**
 * The evidence behind the admission floors, as fixtures rather than as lore.
 *
 * Two distributions decide a floor and both have to be measured: what unrelated text scores
 * against this embedding model, and what a genuine match scores. Measuring the first and
 * skipping the second sets a floor that cannot tell "rejects unrelated text" from "rejects
 * everything".
 *
 * On snowflake-arctic-embed2 the two tails separate: the highest unrelated reading is 0.083
 * under the weakest genuine match, and both floors, 0.35 and 0.33, sit in that gap. Weak
 * genuine matches still land under the floors, and corroboration and exact hits are what carry
 * those.
 *
 * `floor-calibration.int.test.ts` embeds every pair here against live Ollama and asserts the
 * committed floors still separate the two distributions. `floor-battery.int.test.ts` runs the
 * query batteries through the whole pipeline: the off-topic battery must come back thin or
 * empty, and the on-topic battery must still hit.
 */

/**
 * Mutually unrelated, one subject each: six sentences that share nothing, crossed as 30
 * ordered pairs.
 */
export const UNRELATED_SENTENCES: readonly string[] = [
  'The monsoon rainfall variability across Tamil Nadu districts peaked in October.',
  'To re-tension a bicycle wheel spoke, work a quarter turn at a time around the rim.',
  'Anchovy fillets are cured in salt for at least three months before they are canned.',
  'Surface codes correct quantum errors by measuring stabilizers on a lattice of qubits.',
  'The Reykjavik ferry logged eleven albatross sightings in the winter of 1974.',
  'Sourdough starter doubles in about six hours at twenty-four degrees.',
];

export type ScoredPair = {
  readonly cue: string;
  readonly content: string;
};

/**
 * The shape the floor actually faces: an off-topic query against stored engineering content.
 * Every entry pairs one of the measured miss queries with the substrate text that surfaced for
 * it, so the noise distribution is measured on the real failure rather than on abstract
 * sentence pairs.
 */
export const UNRELATED_PAIRS: readonly ScoredPair[] = [
  {
    cue: 'how do I re-tension a bicycle wheel spoke',
    content: 'Feature flags are not re-read during the middle of a request.',
  },
  {
    cue: 'quantum error correction surface codes for topological qubits',
    content: 'ops surface (concept): the maintenance burden of Kafka.',
  },
  {
    cue: 'monsoon rainfall variability across Tamil Nadu districts',
    content: 'Use a Postgres outbox table plus a polling worker for remittance ingest.',
  },
  {
    cue: 'how many albatrosses did the Reykjavik ferry log in 1974',
    content: 'We will not shard the orders table.',
  },
  {
    cue: 'zzqxwv plortnak vugglesnorf',
    content: 'The split migration takes 4 minutes 12 seconds against a production-sized copy.',
  },
  {
    cue: 'what is the best anchovy brand for puttanesca',
    content: 'Database connection string was exposed in logs.',
  },
  {
    cue: 'how do I re-tension a bicycle wheel spoke',
    content: 'We reject the proposal to write to the finops-owned billing table directly.',
  },
  {
    cue: 'monsoon rainfall variability across Tamil Nadu districts',
    content: 'Barrel exports can hide circular dependencies until re-exports are removed.',
  },
  // The noise ceiling the first eight pairs miss. Every one of these was measured against the
  // live substrate as a served item on an off-topic query, and each scores above the whole
  // fixture set's maximum: an entity gloss or a rephrased operational note answers nothing and
  // still lands near a genuine match, because both are technical prose about a named thing.
  // A floor calibrated without them is calibrated against text simpler than what is stored.
  {
    cue: 'zzqxwv plortnak vugglesnorf',
    content: 'ZWJ sequences (concept): Zero Width Joiner sequences are tested for emoji rendering.',
  },
  {
    cue: 'what is the Grimble sprocket calibration for the Vondish array',
    content: 'Key the ZORNAX9931 dedupe on the vendor slug rather than on the display name.',
  },
  {
    cue: 'how do I re-tension a bicycle wheel spoke',
    content:
      'rollback tooling (tool): A set of tools designed to revert a release to its previous version.',
  },
  {
    cue: 'monsoon rainfall variability across Tamil Nadu districts',
    content: 'Duplicate storm probe observations are being sent repeatedly.',
  },
  {
    cue: 'zzqxwv plortnak vugglesnorf',
    content: 'Unicode supports multiple writing systems in one document.',
  },
];

/**
 * Genuine matches: the content answers the query and names its subject. These are the pairs a
 * floor is not allowed to starve, lifted from an extraction judged faithful, including the two
 * recorded rank-1 successes.
 */
export const RELATED_PAIRS: readonly ScoredPair[] = [
  {
    cue: 'did we decide to shard the orders table',
    content: 'We will not shard the orders table.',
  },
  {
    cue: 'what did we decide about the finops billing table',
    content: 'We reject the proposal to write to the finops-owned billing table directly.',
  },
  {
    cue: 'how long does the split migration take on a production sized copy',
    content: 'The split migration takes 4 minutes 12 seconds against a production-sized copy.',
  },
  {
    cue: 'database connection string leaked password and credential rotation',
    content: 'Database connection string was exposed in logs.',
  },
  {
    cue: 'how long did the migration take',
    content: 'The split migration takes 4 minutes 12 seconds against a production-sized copy.',
  },
  {
    cue: 'what did we decide about how the remittance files get ingested',
    content: 'Use a Postgres outbox table plus a polling worker for remittance ingest.',
  },
  {
    cue: 'why did the barrel export hide the circular dependency',
    content: 'Barrel exports can hide circular dependencies until re-exports are removed.',
  },
  {
    cue: 'what is the idempotency key supposed to hash',
    content: 'An idempotency key must hash the identity of the event, not the envelope around it.',
  },
  {
    cue: 'are we rotating the leaked credential',
    content: 'Database connection string was exposed in logs.',
  },
  {
    cue: 'what happened with the feature flag caching',
    content: 'Feature flags are not re-read during the middle of a request.',
  },
];

/**
 * Related, and under the floor. A vague query names no subject, so its cosine against the
 * answer sits inside the noise band and no floor can admit it without admitting noise with it.
 * These are what corroboration and exact lexical hits exist for, not an argument for a lower
 * floor. The calibration test measures them and reports them; it asserts nothing about them.
 */
export const WEAK_RELATED_PAIRS: readonly ScoredPair[] = [
  {
    cue: 'what am I working on',
    content: 'Get the Halyard ledger onto the new PostgreSQL primary.',
  },
  {
    cue: 'is the fix already in the runbook',
    content: 'The split migration takes 4 minutes 12 seconds against a production-sized copy.',
  },
  { cue: 'what did we decide', content: 'We will not shard the orders table.' },
  {
    cue: 'why did we reject that',
    content: 'We reject the proposal to write to the finops-owned billing table directly.',
  },
];

/** One stored memory for the battery substrate. */
export type BatteryEpisode = {
  readonly id: string;
  readonly observation: string;
};

/**
 * The substrate both batteries read. Every line is content that was actually stored or
 * extracted, so a hit and a miss both mean what they meant when measured.
 */
export const BATTERY_SUBSTRATE: readonly BatteryEpisode[] = [
  { id: 'shard', observation: 'We will not shard the orders table.' },
  {
    id: 'finops',
    observation: 'We reject the proposal to write to the finops-owned billing table directly.',
  },
  {
    id: 'migration',
    observation: 'The split migration takes 4 minutes 12 seconds against a production-sized copy.',
  },
  { id: 'connection-string', observation: 'Database connection string was exposed in logs.' },
  {
    id: 'remittance',
    observation: 'Use a Postgres outbox table plus a polling worker for remittance ingest.',
  },
  {
    id: 'barrel',
    observation: 'Barrel exports can hide circular dependencies until re-exports are removed.',
  },
  {
    id: 'idempotency',
    observation:
      'An idempotency key must hash the identity of the event, not the envelope around it.',
  },
  {
    id: 'feature-flags',
    observation: 'Feature flags are not re-read during the middle of a request.',
  },
  {
    id: 'ops-surface',
    observation: 'The ops surface concept covers the maintenance burden of Kafka.',
  },
  { id: 'halyard', observation: 'Get the Halyard ledger onto the new PostgreSQL primary.' },
];

/**
 * The measured miss queries, verbatim where they were recorded. Every one returned a full,
 * budget-saturated pack of confident items; the floor's job is to make them thin or empty.
 */
export const OFF_TOPIC_BATTERY: readonly string[] = [
  'how do I re-tension a bicycle wheel spoke',
  'monsoon rainfall variability across Tamil Nadu districts',
  'quantum error correction surface codes for topological qubits',
  'zzqxwv plortnak vugglesnorf',
  'how many albatrosses did the Reykjavik ferry log in 1974',
  'what is the best anchovy brand for puttanesca',
];

export type OnTopicProbe = {
  readonly query: string;
  /** The `BATTERY_SUBSTRATE` id the pack has to carry back. */
  readonly expects: string;
};

/**
 * The paired half of the gate: the floor has to starve noise without starving these. Three are
 * recorded rank-1 successes; the rest are other measured hits.
 */
export const ON_TOPIC_BATTERY: readonly OnTopicProbe[] = [
  { query: 'did we decide to shard the orders table', expects: 'shard' },
  { query: 'what did we decide about the finops billing table', expects: 'finops' },
  {
    query: 'how long does the split migration take on a production sized copy',
    expects: 'migration',
  },
  {
    query: 'database connection string leaked password and credential rotation',
    expects: 'connection-string',
  },
  {
    query: 'what did we decide about how the remittance files get ingested',
    expects: 'remittance',
  },
  { query: 'what is the idempotency key supposed to hash', expects: 'idempotency' },
];
