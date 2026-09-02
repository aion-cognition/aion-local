/**
 * The subject-keyed close's battery, as data: 24 designed observation pairs with ground truth
 * committed here rather than read off what the mechanism did.
 *
 * A pair of episodes, not a pair of nodes. The keyed close is only as good as the key extraction
 * puts on a claim, and a fixture that handed the graph a key would measure a mechanism nobody
 * ships. Each case is what a session actually said, first and later, and everything between the
 * words and the close is the thing under test.
 *
 * The classes come from what the key makes reachable and what it makes dangerous. A value that
 * changed under an unchanged attribute name is the whole point of a mechanical close, and it is
 * the `same-key` class. `aspect-collision` is the failure the key invents: two genuinely
 * different attributes of one thing whose plain-English names both shorten to one slug, where
 * the close has no judge behind it to catch the mistake. `different-aspect` is the same subject
 * with nothing in common between the attributes, which is the case the string-containment
 * heuristic used to close. `unkeyed` is a session that states no single attribute of one named
 * thing, which should key nothing and leave the pair where it has always gone.
 *
 * The prior and the new half spell the subject the same way on purpose. Two spellings are entity
 * dedup's problem, and a fixture that mixed them in would report the cascade's recall as the
 * key's.
 */

export type KeyedCaseClass = 'same-key' | 'aspect-collision' | 'different-aspect' | 'unkeyed';

export const KEYED_CASE_CLASSES: readonly KeyedCaseClass[] = [
  'same-key',
  'aspect-collision',
  'different-aspect',
  'unkeyed',
];

export type KeyedCase = {
  readonly key: string;
  readonly caseClass: KeyedCaseClass;
  /** The pre-committed answer: does the later observation replace what the earlier one said. */
  readonly corrects: boolean;
  /** What the substrate was told first. */
  readonly prior: string;
  /** What it was told later. */
  readonly next: string;
  /** Why the answer is what it is, for the line the battery prints when it disagrees. */
  readonly truthNote: string;
};

/** One subject, one attribute, a new value: the only class a mechanical close may take. */
const SAME_KEY: readonly KeyedCase[] = [
  {
    key: 'quillon-retry-limit',
    caseClass: 'same-key',
    corrects: true,
    prior: 'The Quillon ingest pipeline retry limit is three attempts.',
    next: 'The Quillon ingest pipeline retry limit is seven attempts now, raised from three.',
    truthNote: 'one pipeline, one retry limit, a number that changed',
  },
  {
    key: 'halberd-checkpoint-store',
    caseClass: 'same-key',
    corrects: true,
    prior: 'Halberd stores its checkpoint state in Redis.',
    next: 'Halberd stores its checkpoint state in Postgres now; Redis is no longer used for it.',
    truthNote: 'one service, one checkpoint store, moved from one system to another',
  },
  {
    key: 'marlin-deploy-region',
    caseClass: 'same-key',
    corrects: true,
    prior: 'The Marlin billing service deploys to AWS us-east-1.',
    next: 'The Marlin billing service deploys to Fly.io now; AWS us-east-1 is retired.',
    truthNote: 'one service, one deployment target, replaced',
  },
  {
    key: 'corvid-token-storage',
    caseClass: 'same-key',
    corrects: true,
    prior: 'Corvid session tokens are kept in browser local storage.',
    next: 'Corvid session tokens are kept in an httpOnly cookie now, never in local storage.',
    truthNote: 'one product, one place tokens live, reversed',
  },
  {
    key: 'solstice-sweep-cadence',
    caseClass: 'same-key',
    corrects: true,
    prior: 'The Solstice reconciliation sweep runs every fifteen minutes.',
    next: 'The Solstice reconciliation sweep runs once an hour now, down from every fifteen minutes.',
    truthNote: 'one sweep, one cadence, a new interval',
  },
  {
    key: 'perigee-embedding-model',
    caseClass: 'same-key',
    corrects: true,
    prior: 'Perigee search embeds documents with nomic-embed-text.',
    next: 'Perigee search embeds documents with snowflake-arctic-embed2 now.',
    truthNote: 'one search stack, one embedding model, swapped',
  },
  {
    key: 'thornwood-queue-backend',
    caseClass: 'same-key',
    corrects: true,
    prior: 'The Thornwood job queue runs on RabbitMQ.',
    next: 'The Thornwood job queue runs on SQS now; the RabbitMQ cluster is decommissioned.',
    truthNote: 'one queue, one backend, replaced',
  },
  {
    key: 'vesper-owning-team',
    caseClass: 'same-key',
    corrects: true,
    prior: 'The Vesper gateway is owned by the platform team.',
    next: 'The Vesper gateway is owned by the payments team now; the platform team handed it over.',
    truthNote: 'one gateway, one owning team, transferred',
  },
];

/**
 * Two attributes of one thing whose names collide once they are shortened to a slug. Both
 * statements stay true, and a close here is the failure mode the key introduces on its own.
 */
const ASPECT_COLLISION: readonly KeyedCase[] = [
  {
    key: 'halyard-timeouts',
    caseClass: 'aspect-collision',
    corrects: false,
    prior: 'The Halyard proxy request timeout is thirty seconds.',
    next: 'The Halyard proxy lock timeout is five seconds.',
    truthNote: 'a request timeout and a lock timeout are two settings, both in force',
  },
  {
    key: 'nimbus-limits',
    caseClass: 'aspect-collision',
    corrects: false,
    prior: 'The Nimbus uploader file size limit is twenty-five megabytes.',
    next: 'The Nimbus uploader rate limit is one hundred requests a minute.',
    truthNote: 'a size limit and a rate limit are two settings, both in force',
  },
  {
    key: 'ravel-defaults',
    caseClass: 'aspect-collision',
    corrects: false,
    prior: 'The Ravel repository default branch is main.',
    next: 'The Ravel repository default reviewer is the release captain.',
    truthNote: 'a default branch and a default reviewer are two settings, both in force',
  },
  {
    key: 'kestrel-ports',
    caseClass: 'aspect-collision',
    corrects: false,
    prior: 'The Kestrel daemon admin port is 9000.',
    next: 'The Kestrel daemon metrics port is 9100.',
    truthNote: 'an admin port and a metrics port are two ports, both listening',
  },
  {
    key: 'bramble-intervals',
    caseClass: 'aspect-collision',
    corrects: false,
    prior: 'The Bramble indexer flush interval is ten seconds.',
    next: 'The Bramble indexer retry interval is two minutes.',
    truthNote: 'a flush interval and a retry interval are two timers, both running',
  },
  {
    key: 'cinder-sizes',
    caseClass: 'aspect-collision',
    corrects: false,
    prior: 'The Cinder cache batch size is five hundred rows.',
    next: 'The Cinder cache page size is fifty rows.',
    truthNote: 'a batch size and a page size are two numbers, both correct',
  },
];

/**
 * One subject, two attributes with nothing in common. This is what the containment heuristic
 * closed before a key existed: the later claim carries the subject's name, and that was enough.
 */
const DIFFERENT_ASPECT: readonly KeyedCase[] = [
  {
    key: 'wexford-runtime-owner',
    caseClass: 'different-aspect',
    corrects: false,
    prior: 'The Wexford exporter runs on Node 22.',
    next: 'The Wexford exporter is owned by the data platform team.',
    truthNote: 'a runtime version and an owning team are unrelated facts about one exporter',
  },
  {
    key: 'pallas-region-language',
    caseClass: 'different-aspect',
    corrects: false,
    prior: 'The Pallas transcoder is deployed in eu-central-1.',
    next: 'The Pallas transcoder is written in Rust.',
    truthNote: 'a deployment region says nothing about an implementation language',
  },
  {
    key: 'ashgrove-retention-schedule',
    caseClass: 'different-aspect',
    corrects: false,
    prior: 'Ashgrove audit logs are retained for ninety days.',
    next: 'Ashgrove audit logs are shipped nightly at 02:00 UTC.',
    truthNote: 'a retention window and a shipping schedule are two policies on one log',
  },
  {
    key: 'larkspur-store-auth',
    caseClass: 'different-aspect',
    corrects: false,
    prior: 'The Larkspur API stores its data in Postgres.',
    next: 'The Larkspur API authenticates callers with mutual TLS.',
    truthNote: 'a datastore and an authentication scheme are unrelated facts about one API',
  },
  {
    key: 'fennec-budget-staffing',
    caseClass: 'different-aspect',
    corrects: false,
    prior: 'The Fennec migration has a budget of four weeks.',
    next: 'The Fennec migration is staffed by three engineers.',
    truthNote: 'a schedule budget and a headcount are two facts about one migration',
  },
  {
    key: 'tarn-format-transport',
    caseClass: 'different-aspect',
    corrects: false,
    prior: 'The Tarn feed serializes its records as Avro.',
    next: 'The Tarn feed is delivered over gRPC.',
    truthNote: 'a serialization format and a transport are two layers of one feed',
  },
];

/**
 * Sessions that state no single attribute of one named thing. Extraction should decline the key
 * on these, and the pair should reach the judge exactly as it did before keys existed.
 */
const UNKEYED: readonly KeyedCase[] = [
  {
    key: 'latency-spike-reading',
    caseClass: 'unkeyed',
    corrects: false,
    prior:
      'We spent the afternoon reading ingest logs and arguing about whether the latency spikes were real.',
    next: 'The spikes turned out to be an artifact of the sampling window rather than anything in the traffic.',
    truthNote: 'a record of an afternoon and a record of what it found, both true afterwards',
  },
  {
    key: 'ferrous-smoke-run',
    caseClass: 'unkeyed',
    corrects: false,
    prior: 'The Ferrous loader and the Ferrous unloader both failed the smoke test this morning.',
    next: 'The smoke suite was rebuilt in the afternoon and the whole run came back green.',
    truthNote: 'two observations at two times; the morning run still failed',
  },
  {
    key: 'quarry-planner-question',
    caseClass: 'unkeyed',
    corrects: false,
    prior:
      'Nobody is sure whether the Quarry planner should run before or after the compaction pass.',
    next: 'We decided to revisit the planner ordering next quarter rather than settle it now.',
    truthNote: 'an open question and a decision to defer it, neither replacing the other',
  },
  {
    key: 'friday-deploy-talk',
    caseClass: 'unkeyed',
    corrects: false,
    prior: 'Deploying on a Friday feels risky, so the team talked it over at lunch.',
    next: 'Everyone agreed the deploy freeze should stay informal for now.',
    truthNote: 'a conversation and its outcome, with no attribute of anything asserted',
  },
];

export const KEYED_BATTERY: readonly KeyedCase[] = [
  ...SAME_KEY,
  ...ASPECT_COLLISION,
  ...DIFFERENT_ASPECT,
  ...UNKEYED,
];

export function casesOfClass(caseClass: KeyedCaseClass): readonly KeyedCase[] {
  return KEYED_BATTERY.filter((entry) => entry.caseClass === caseClass);
}

/** The two episode ids a case seeds. Both halves are needed to say which way a close ran. */
export function priorEpisodeId(entry: KeyedCase): string {
  return `${entry.key}-prior`;
}

export function newEpisodeId(entry: KeyedCase): string {
  return `${entry.key}-new`;
}
