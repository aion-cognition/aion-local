/**
 * The entity dedup cascade's battery, as data: 24 designed pairs with ground truth committed
 * here rather than read off what the cascade decided.
 *
 * A pair, not an episode. What the cascade weighs is two identities and what the graph records
 * about them together, so a battery built on pairs measures the cascade and nothing upstream of
 * it: extraction fidelity is a separate failure with its own numbers.
 *
 * The classes come from the shapes the re-key made reachable and the shapes it made dangerous.
 * Separator variants are what `name_norm` uniqueness cannot see and tier 0 exists for.
 * Morphological variants and cross-type same-referent pairs are what the old composite key hid:
 * for as long as two extractions disagreed about what kind of thing something was, its duplicate
 * was invisible. Namesakes, cross-type distinct referents and identifier-shaped pairs are the
 * cost of removing that filter, and `gitlab-token` against `github-token` is the standing case:
 * 0.9109 on name form, two credentials, never one thing.
 *
 * Co-mention counts run against the truth on purpose. Two names for one thing exist because two
 * records did not name them together; two namesakes turn up in one conversation constantly. A
 * fixture where the graph evidence pointed at the answer would measure the fixture.
 */

export type CascadeCaseClass =
  | 'separator'
  | 'morphological'
  | 'cross-type-same'
  | 'namesake'
  | 'cross-type-distinct'
  | 'identifier';

export type CascadeSide = {
  readonly name: string;
  /** The label the node wears. Evidence in the prompt, and a filter nowhere. */
  readonly type: string;
  /** The stored description, which is what tier 3 reads about each side. */
  readonly description: string;
};

export type CascadeCase = {
  readonly key: string;
  readonly caseClass: CascadeCaseClass;
  /** The pre-committed answer: is one referent in the world holding both records. */
  readonly duplicate: boolean;
  readonly left: CascadeSide;
  readonly right: CascadeSide;
  /**
   * How many episodes name both sides. One for a duplicate, three for a pair that is not one:
   * shared history is evidence for merging, so the false class carries more of it than the true
   * class does.
   */
  readonly coMentions: number;
  /** Why the answer is what it is, for the line the battery prints when it disagrees. */
  readonly truthNote: string;
};

/** Three separator variants: one name spelled two ways, which tier 0 reads without a model. */
const SEPARATOR_VARIANTS: readonly CascadeCase[] = [
  {
    key: 'held-out-recall',
    caseClass: 'separator',
    duplicate: true,
    left: {
      name: 'held-out-recall',
      type: 'topic',
      description:
        'The gate battery that asks the substrate questions whose answers were held out of what it was told.',
    },
    right: {
      name: 'held_out_recall',
      type: 'topic',
      description:
        'A recall gate: questions the substrate was never given the answers to, scored on what it serves back.',
    },
    coMentions: 1,
    truthNote: 'one battery, written with dashes in one record and underscores in the other',
  },
  {
    key: 'hetzner-falkenstein',
    caseClass: 'separator',
    duplicate: true,
    left: {
      name: 'Hetzner Falkenstein',
      type: 'location',
      description: 'The Hetzner data centre in Falkenstein where the billing worker used to run.',
    },
    right: {
      name: 'hetzner-falkenstein',
      type: 'location',
      description: "Hetzner's Falkenstein region, retired as a deploy target after the move.",
    },
    coMentions: 1,
    truthNote: 'one data centre, spelled as two words in one record and hyphenated in the other',
  },
  {
    key: 'bm25',
    caseClass: 'separator',
    duplicate: true,
    left: {
      name: 'bm25',
      type: 'topic',
      description: 'The lexical ranking function the fulltext leg of recall scores candidates by.',
    },
    right: {
      name: 'bm-25',
      type: 'topic',
      description: "A term-frequency ranking function used by the search layer's keyword leg.",
    },
    coMentions: 1,
    truthNote: 'one ranking function, and the hyphen is the whole of the difference',
  },
];

/** Five morphological variants: an abbreviation, an expansion, a shortening, a fuller form. */
const MORPHOLOGICAL_VARIANTS: readonly CascadeCase[] = [
  {
    key: 'postgres',
    caseClass: 'morphological',
    duplicate: true,
    left: {
      name: 'postgres',
      type: 'tool',
      description: 'The relational database the reporting stack reads from.',
    },
    right: {
      name: 'postgresql',
      type: 'topic',
      description:
        'Open-source relational database management system; the store behind the reporting stack.',
    },
    coMentions: 1,
    truthNote: 'the short name and the full name of one database',
  },
  {
    key: 'kubernetes',
    caseClass: 'morphological',
    duplicate: true,
    left: {
      name: 'kubernetes',
      type: 'tool',
      description: 'The container orchestrator the platform team runs the workers on.',
    },
    right: {
      name: 'k8s',
      type: 'tool',
      description: 'The orchestration platform the worker deployments are scheduled by.',
    },
    coMentions: 1,
    truthNote: 'a numeronym for the same orchestrator',
  },
  {
    key: 'anthropic',
    caseClass: 'morphological',
    duplicate: true,
    left: {
      name: 'Anthropic',
      type: 'organization',
      description: 'The company whose models the reflect role routes to when a key is present.',
    },
    right: {
      name: 'Anthropic PBC',
      type: 'organization',
      description:
        'A public benefit corporation building large language models, including the Claude family.',
    },
    coMentions: 1,
    truthNote: 'one company, with and without its legal suffix',
  },
  {
    key: 'volkov',
    caseClass: 'morphological',
    duplicate: true,
    left: {
      name: 'Dmitri Volkov',
      type: 'person',
      description: 'An engineer who owned the Quillon ingest pipeline before it transferred.',
    },
    right: {
      name: 'D. Volkov',
      type: 'person',
      description: 'Former owner of the ingest pipeline, named that way in the handover notes.',
    },
    coMentions: 1,
    truthNote: 'one person, written out in one record and initialled in the other',
  },
  {
    key: 'gds',
    caseClass: 'morphological',
    duplicate: true,
    left: {
      name: 'GDS',
      type: 'topic',
      description: 'The Neo4j plugin the nomination pass calls for node similarity.',
    },
    right: {
      name: 'Graph Data Science',
      type: 'tool',
      description: "Neo4j's graph algorithms library, used here for the node-similarity pass.",
    },
    coMentions: 1,
    truthNote: 'an initialism and the phrase it stands for',
  },
];

/**
 * Four pairs whose two records wear different labels and describe one referent. These are the
 * merges the composite key made unreachable, so a cascade that quietly reinstated a type filter
 * would fail here and nowhere else.
 */
const CROSS_TYPE_SAME: readonly CascadeCase[] = [
  {
    key: 'retell',
    caseClass: 'cross-type-same',
    duplicate: true,
    left: {
      name: 'Retell',
      type: 'organization',
      description: 'The vendor behind the phone-support voice agent.',
    },
    right: {
      name: 'Retell AI',
      type: 'tool',
      description: 'The voice agent platform the phone-support assistant is built on.',
    },
    coMentions: 1,
    truthNote: 'a platform and the company it is named for, read as two kinds of thing',
  },
  {
    key: 'solace',
    caseClass: 'cross-type-same',
    duplicate: true,
    left: {
      name: 'Solace Health',
      type: 'organization',
      description: 'The healthcare company the advocate-facing app is built for.',
    },
    right: {
      name: 'Solace',
      type: 'project',
      description: 'The healthcare platform whose server, app and admin repos this work lives in.',
    },
    coMentions: 1,
    truthNote: 'one name, read once as the company and once as the platform it ships',
  },
  {
    key: 'arctic2',
    caseClass: 'cross-type-same',
    duplicate: true,
    left: {
      name: 'arctic2',
      type: 'tool',
      description: 'The embedding model the substrate moved to at the reset, 1024 dimensions.',
    },
    right: {
      name: 'snowflake-arctic-embed2',
      type: 'topic',
      description:
        "Snowflake's second-generation embedding model: 8192-token window, 1024 dimensions.",
    },
    coMentions: 1,
    truthNote: 'the tag everyone says and the tag the config pins, for one model',
  },
  {
    key: 'fireflies',
    caseClass: 'cross-type-same',
    duplicate: true,
    left: {
      name: 'Fireflies',
      type: 'tool',
      description: 'The meeting recorder the interview write-ups draw their transcripts from.',
    },
    right: {
      name: 'Fireflies.ai',
      type: 'organization',
      description: 'The company selling the meeting transcription service used for recordings.',
    },
    coMentions: 1,
    truthNote: 'the product and its domain name, read as two kinds of thing',
  },
];

/** Six namesakes: two things that share most of a name and cannot share a referent. */
const NAMESAKES: readonly CascadeCase[] = [
  {
    key: 'forge-tokens',
    caseClass: 'namesake',
    duplicate: false,
    left: {
      name: 'gitlab-token',
      type: 'tool',
      description: 'The personal access token the release job authenticates to GitLab with.',
    },
    right: {
      name: 'github-token',
      type: 'tool',
      description: 'The personal access token the release job authenticates to GitHub with.',
    },
    coMentions: 3,
    truthNote: 'two credentials for two forges, and a credential belongs to exactly one of them',
  },
  {
    key: 'supersession-modules',
    caseClass: 'namesake',
    duplicate: false,
    left: {
      name: 'supersession-apply',
      type: 'tool',
      description: 'The module that closes a claim once a judgment has been agreed.',
    },
    right: {
      name: 'supersession-review',
      type: 'tool',
      description: 'The module that runs the second pass, arguing against a proposed close.',
    },
    coMentions: 3,
    truthNote: 'two modules of one system, each with its own job',
  },
  {
    key: 'redis-valkey',
    caseClass: 'namesake',
    duplicate: false,
    left: {
      name: 'Redis',
      type: 'tool',
      description: 'The in-memory store the session state used to live in.',
    },
    right: {
      name: 'Valkey',
      type: 'tool',
      description:
        'The fork of that in-memory store the platform moved to after the licence change.',
    },
    coMentions: 3,
    truthNote:
      'a fork and its origin: one history, two projects, and the scar this cascade carries',
  },
  {
    key: 'python-versions',
    caseClass: 'namesake',
    duplicate: false,
    left: {
      name: 'Python 3.11',
      type: 'tool',
      description: 'The interpreter version the ingest jobs still run on.',
    },
    right: {
      name: 'Python 3.12',
      type: 'tool',
      description: 'The interpreter version the new services are built against.',
    },
    coMentions: 3,
    truthNote: 'two versions, and a claim about one is not a claim about the other',
  },
  {
    key: 'priya',
    caseClass: 'namesake',
    duplicate: false,
    left: {
      name: 'Priya Raghunathan',
      type: 'person',
      description: 'An engineer who prefers release branches for the Solstice repo.',
    },
    right: {
      name: 'Priya Venkatesan',
      type: 'person',
      description: 'A data engineer on the reporting team, on call for the warehouse.',
    },
    coMentions: 3,
    truthNote: 'two people sharing a first name',
  },
  {
    key: 'marlin-workers',
    caseClass: 'namesake',
    duplicate: false,
    left: {
      name: 'Marlin billing worker',
      type: 'tool',
      description: 'The worker that issues invoices on the Marlin billing schedule.',
    },
    right: {
      name: 'Marlin reconciliation worker',
      type: 'tool',
      description: 'The worker that reconciles the Marlin ledger against the payment provider.',
    },
    coMentions: 3,
    truthNote: 'two services in one system, deployed and paged separately',
  },
];

/**
 * Three pairs whose labels differ and whose referents differ too. The mirror of the cross-type
 * duplicates: a cascade that merged on differing labels being irrelevant would fail these.
 */
const CROSS_TYPE_DISTINCT: readonly CascadeCase[] = [
  {
    key: 'reflection-orchestrator',
    caseClass: 'cross-type-distinct',
    duplicate: false,
    left: {
      name: 'reflection',
      type: 'topic',
      description:
        'The part of the pipeline where an episode is enriched into entities, claims and edges.',
    },
    right: {
      name: 'ReflectionOrchestrator',
      type: 'tool',
      description: 'The class that runs the reflection stage list in order over one episode.',
    },
    coMentions: 3,
    truthNote: 'a subject and one component that implements part of it',
  },
  {
    key: 'thornbury',
    caseClass: 'cross-type-distinct',
    duplicate: false,
    left: {
      name: 'Thornbury',
      type: 'project',
      description:
        'The index rebuild that went from six hours to forty minutes after partitioning.',
    },
    right: {
      name: 'Thornbury Street',
      type: 'location',
      description: 'The street the London office is on.',
    },
    coMentions: 3,
    truthNote: 'a project and a street, sharing a name and nothing else',
  },
  {
    key: 'quillon',
    caseClass: 'cross-type-distinct',
    duplicate: false,
    left: {
      name: 'Quillon',
      type: 'project',
      description: 'The ingest pipeline that loads partner files into the warehouse.',
    },
    right: {
      name: 'Quillon team',
      type: 'organization',
      description: 'The engineers who own that ingest pipeline and its on-call rotation.',
    },
    coMentions: 3,
    truthNote: 'a pipeline and the group named after it',
  },
];

/**
 * Three identifier-shaped pairs, where nearly every character agrees and the one that differs
 * is the whole of the meaning. The name vector reads these as near-identical, which is exactly
 * why nothing downstream of it may treat a high score as an answer.
 */
const IDENTIFIER_TRAPS: readonly CascadeCase[] = [
  {
    key: 'replay-runs',
    caseClass: 'identifier',
    duplicate: false,
    left: {
      name: 'run-7f3a91',
      type: 'topic',
      description: 'The replay run that reprocessed the August archive.',
    },
    right: {
      name: 'run-7f3a92',
      type: 'topic',
      description: 'The replay run that reprocessed the September archive.',
    },
    coMentions: 3,
    truthNote: 'two runs, one character apart in their ids',
  },
  {
    key: 'image-digests',
    caseClass: 'identifier',
    duplicate: false,
    left: {
      name: 'sha256:9c1f4b2e',
      type: 'topic',
      description: 'The digest of the extractor image the August episodes were enriched by.',
    },
    right: {
      name: 'sha256:9c1f4b2f',
      type: 'topic',
      description: 'The digest of the extractor image the September episodes were enriched by.',
    },
    coMentions: 3,
    truthNote: 'two digests, and a digest that differs at all names another thing',
  },
  {
    key: 'test-containers',
    caseClass: 'identifier',
    duplicate: false,
    left: {
      name: 'aion-test-neo4j-4931',
      type: 'tool',
      description: 'A throwaway Neo4j container one integration file started and removed.',
    },
    right: {
      name: 'aion-test-neo4j-4932',
      type: 'tool',
      description: 'A throwaway Neo4j container a later integration file started and removed.',
    },
    coMentions: 3,
    truthNote: 'two containers, each alive for one file',
  },
];

export const CASCADE_BATTERY: readonly CascadeCase[] = [
  ...SEPARATOR_VARIANTS,
  ...MORPHOLOGICAL_VARIANTS,
  ...CROSS_TYPE_SAME,
  ...NAMESAKES,
  ...CROSS_TYPE_DISTINCT,
  ...IDENTIFIER_TRAPS,
];

export const CASCADE_CASE_CLASSES: readonly CascadeCaseClass[] = [
  'separator',
  'morphological',
  'cross-type-same',
  'namesake',
  'cross-type-distinct',
  'identifier',
];

export function casesOfClass(caseClass: CascadeCaseClass): readonly CascadeCase[] {
  return CASCADE_BATTERY.filter((entry) => entry.caseClass === caseClass);
}
