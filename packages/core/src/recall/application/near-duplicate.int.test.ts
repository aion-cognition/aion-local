import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallCompletion, type RecallDeps } from './recall.js';
import { RecallSideEffects } from './side-effects.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
} from '../../infrastructure/graph/claim-key-queries.js';
import { fetchClaimProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import {
  normalizeCognitiveText,
  TEXT_NORM_PROPERTY,
} from '../../infrastructure/graph/cognitive-text.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { restatedClaims } from '../../infrastructure/graph/near-duplicate-queries.js';
import { knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';
import { vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import { writeSemanticRelationship } from '../../infrastructure/graph/semantic-relationship-queries.js';
import { accessMetadata } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { SessionManager } from '../../session/session-manager.js';
import { foldableClaims } from '../domain/pack-duplicates.js';
import { assemble, item } from '../domain/test-support/pack.fixture.js';

/**
 * Which pairs of a pack's candidates the substrate calls one claim recorded twice. What the
 * pack does with the answer is `pack-duplicates.ts` and `pack.ts`.
 *
 * The claims here carry the text they would carry in the graph, so the counterexamples are the
 * real sentences rather than numbers standing in for them. Every pair below shares a subject
 * key; what separates them is the stored fold and the relationships between them.
 */

const EMBED_DIMENSION = 8;
const AT = new Date('2026-06-01T09:00:00.000Z');
const LATER = new Date('2026-06-05T09:00:00.000Z');
const BEFORE_LATER = new Date('2026-06-03T09:00:00.000Z');

const SUBJECT = 'entity-queue-worker';
const OTHER_SUBJECT = 'entity-token-budget';
const ASPECT = 'retry ceiling';
const OTHER_ASPECT = 'owning team';

/** The keyed pair the recall case reads back, worded so nothing else in the file shares it. */
const RECALL_SUBJECT = 'entity-dispatcher';
const RECALL_ASPECT = 'drain day';
const RECALL_FIRST = 'recall-fold-first';
const RECALL_SECOND = 'recall-fold-second';
const RECALL_CUE = 'dispatcher';
const RECALL_SESSION = 'near-duplicate-recall';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sideEffects: RecallSideEffects;
let deps: RecallDeps;

/** Only the recall pair carries a content vector, so the pack that comes back is those two. */
function unit(axis: number): Vector {
  const raw = new Array<number>(EMBED_DIMENSION).fill(0.001);
  raw[axis] = 0.99;
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

const RECALL_VECTOR = unit(0);

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(() => RECALL_VECTOR)),
  generate: () =>
    Promise.resolve({ query_cues: [RECALL_CUE], summary_cues: [], recent_turn_cues: [] }),
};

type ClaimInput = {
  readonly id: string;
  readonly text: string;
  readonly subject?: string;
  readonly aspect?: string;
  readonly keyed?: false;
  readonly at?: Date;
  readonly vector?: Vector;
};

async function writeClaim(input: ClaimInput): Promise<void> {
  const at = input.at ?? AT;
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id: input.id,
    now: at,
    occurredAt: at,
    properties: {
      text: input.text,
      ...(input.keyed === false
        ? {}
        : { [TEXT_NORM_PROPERTY]: normalizeCognitiveText(input.text) }),
      ...(input.keyed === false ? {} : { [CLAIM_SUBJECT_PROPERTY]: input.subject ?? SUBJECT }),
      ...(input.keyed === false ? {} : { [CLAIM_ASPECT_PROPERTY]: input.aspect ?? ASPECT }),
      ...(input.vector === undefined ? {} : { content_vec: [...input.vector] }),
    },
  });
}

async function pairsAmong(ids: readonly string[], at?: Date): Promise<string[]> {
  const rows = await restatedClaims(harness.driver, {
    ids,
    mode: at === undefined ? withCurrency() : knewAt(at),
  });
  return rows.map((row) => `${row.left}|${row.right}`).sort();
}

/**
 * The pairs a cosine would call one claim and the substrate does not. Measured against the
 * shipped embedding model on this text: the retry counts read 0.997, the two sign-ins 0.993,
 * the retention windows 0.995, and the enabled/disabled pair 0.965, against 0.788 for the two
 * wordings of one login claim further down. Any floor that folds the last one folds all of
 * these, which is why the fold and not the cosine decides.
 */
const COUNTEREXAMPLES: readonly (readonly [string, string])[] = [
  [
    'count-five',
    'The queue worker retries a failed integration job at most 5 times before moving it to the dead-letter queue.',
  ],
  [
    'count-six',
    'The queue worker retries a failed integration job at most 6 times before moving it to the dead-letter queue.',
  ],
  ['signin-monday', 'Ana signed in from the Berlin office on Monday.'],
  ['signin-friday', 'Ana signed in from the Berlin office on Friday.'],
  ['retain-thirty', 'The experience archive retains raw session transcripts for 30 days.'],
  ['retain-ninety', 'The experience archive retains raw session transcripts for 90 days.'],
  ['passkey-on', 'passkey login is enabled for staff'],
  ['passkey-off', 'passkey login is disabled for staff'],
  ['login-moved', 'the login flow moved to the edge worker'],
  ['login-runs', 'login now runs on the edge worker'],
];

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-near-duplicate-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  for (const [id, text] of COUNTEREXAMPLES) {
    await writeClaim({ id, text });
  }

  // One sentence recorded twice, spelled differently the second time. The stored fold collapses
  // case and whitespace, which is what makes these one claim and the pairs above ten.
  await writeClaim({ id: 'fold-a', text: 'The queue runs on Valkey.' });
  await writeClaim({ id: 'fold-b', text: '  the Queue   runs on  valkey. ', at: LATER });

  await writeClaim({
    id: 'key-other-aspect',
    text: 'The queue runs on Valkey.',
    aspect: OTHER_ASPECT,
  });
  await writeClaim({
    id: 'key-other-subject',
    text: 'The queue runs on Valkey.',
    subject: OTHER_SUBJECT,
  });
  await writeClaim({ id: 'key-absent', text: 'The queue runs on Valkey.', keyed: false });

  await writeClaim({
    id: 'closed-old',
    text: 'The archive keeps transcripts.',
    aspect: 'retention',
  });
  await writeClaim({
    id: 'closed-new',
    text: 'the Archive keeps transcripts.',
    aspect: 'retention',
    at: LATER,
  });
  await supersede(harness.driver, { oldId: 'closed-old', newId: 'closed-new', now: LATER });

  await writeClaim({
    id: 'clash-a',
    text: 'The worker drains newest first.',
    aspect: 'drain order',
  });
  // Both written before the disagreement was recorded, so a read pinned between the two
  // instants holds both claims and not the edge.
  await writeClaim({
    id: 'clash-b',
    text: 'the Worker drains newest first.',
    aspect: 'drain order',
  });
  await writeClaim({
    id: 'clash-c',
    text: 'THE WORKER DRAINS NEWEST FIRST.',
    aspect: 'drain order',
  });
  await writeClaim({
    id: 'clash-d',
    text: ' the worker drains newest first. ',
    aspect: 'drain order',
  });
  await writeSemanticRelationship(harness.driver, {
    sourceId: 'clash-a',
    targetId: 'clash-b',
    type: 'CONTRADICTS',
    confidence: 1,
    now: LATER,
  });

  await writeClaim({
    id: RECALL_FIRST,
    text: 'The dispatcher drains on Tuesdays.',
    subject: RECALL_SUBJECT,
    aspect: RECALL_ASPECT,
    vector: RECALL_VECTOR,
  });
  await writeClaim({
    id: RECALL_SECOND,
    text: '  the Dispatcher   drains on tuesdays. ',
    subject: RECALL_SUBJECT,
    aspect: RECALL_ASPECT,
    at: LATER,
    vector: RECALL_VECTOR,
  });

  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  sideEffects = new RecallSideEffects(harness.driver, db, logger);
  deps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider,
    config: {
      ...DEFAULTS,
      models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    },
    cueCache: new CueCache(),
    logger,
  };

  await waitFor('the vector index to cover the recall pair', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: RECALL_VECTOR,
      limit: 10,
      mode: withCurrency(),
    });
    const found = new Set(rows.map((row) => row.id));
    return found.has(RECALL_FIRST) && found.has(RECALL_SECOND);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('which candidates the substrate calls one claim recorded twice', () => {
  it('pairs two spellings of one sentence under one subject key', async () => {
    expect(await pairsAmong(['fold-a', 'fold-b'])).toEqual(['fold-a|fold-b']);
  });

  it('pairs none of the claims that state a different answer to the same question', async () => {
    const ids = COUNTEREXAMPLES.map(([id]) => id);

    expect(await pairsAmong(ids)).toEqual([]);
  });

  it('pairs nothing across a different aspect, a different subject, or no key at all', async () => {
    const ids = ['fold-a', 'key-other-aspect', 'key-other-subject', 'key-absent'];

    expect(await pairsAmong(ids)).toEqual([]);
  });

  it('pairs nothing the judge already closed', async () => {
    expect(await pairsAmong(['closed-old', 'closed-new'])).toEqual([]);
  });

  it('pairs nothing a recorded contradiction holds apart, successor or not', async () => {
    expect(await pairsAmong(['clash-a', 'clash-b'])).toEqual([]);
  });

  it('pairs the same two for a read that predates the contradiction being recorded', async () => {
    // Relationship visibility follows the read's own vantage point: at that instant the
    // substrate had not recorded the disagreement, so it cannot be the reason to serve both.
    expect(await pairsAmong(['clash-a', 'clash-b'], BEFORE_LATER)).toEqual(['clash-a|clash-b']);
  });

  it('pairs neither end of a contradiction with a third record of the same sentence', async () => {
    // Group-wise, not pairwise. Excluding only the edge itself leaves both ends free to fold
    // into the third record, and a reader served that one alone loses the disagreement.
    expect(await pairsAmong(['clash-c', 'clash-a', 'clash-b'])).toEqual([]);
  });

  it('still pairs the members of that group no contradiction touches', async () => {
    expect(await pairsAmong(['clash-c', 'clash-d', 'clash-a', 'clash-b'])).toEqual([
      'clash-c|clash-d',
    ]);
  });

  it('asks nothing of the graph for a candidate set too small to hold a pair', async () => {
    expect(await restatedClaims(harness.driver, { ids: [], mode: withCurrency() })).toEqual([]);
    expect(await restatedClaims(harness.driver, { ids: ['fold-a'], mode: withCurrency() })).toEqual(
      [],
    );
  });
});

describe('a contradictory pair beside a third record of the same sentence', () => {
  const CLASH_IDS = ['clash-c', 'clash-a', 'clash-b'];
  const CLASH_LABELS = ['Insight', 'Memory', 'AionNode'];

  it('serves both contradictory endpoints when the third record ranks first', async () => {
    const mode = withCurrency();
    const pairs = await restatedClaims(harness.driver, { ids: CLASH_IDS, mode });
    const provenance = await fetchClaimProvenance(harness.driver, {
      ids: CLASH_IDS,
      mode,
      maxRoots: 16,
    });
    const items = [
      item('clash-c', { labels: CLASH_LABELS, content: 'THE WORKER DRAINS NEWEST FIRST.' }),
      item('clash-a', { labels: CLASH_LABELS, content: 'The worker drains newest first.' }),
      item('clash-b', { labels: CLASH_LABELS, content: 'the Worker drains newest first.' }),
    ];
    const pack = assemble(items, {
      provenance,
      foldable: foldableClaims({ items, pairs, provenance, relatedClaims: new Map() }),
    });

    expect(pack.facts?.map((entry) => entry.id)).toEqual(['clash-c', 'clash-a', 'clash-b']);
    expect(pack.metadata.suppressed_duplicates).toBeUndefined();
  });
});

/**
 * The whole path, from the substrate's own key to what the caller was handed. Cognition still
 * sees both records: the fold is a pack decision, so both ids stay in the retrieved set, and only
 * the record the reader actually got is charged an exposure.
 */
describe('a keyed pair the whole recall path folds', () => {
  it('keeps both ids in telemetry and stamps only the record it served', async () => {
    let completion: RecallCompletion | undefined;
    const pack = await handleRecall(
      {
        ...deps,
        onRecalled: (event) => {
          completion = event;
          return sideEffects.onRecalled(event);
        },
      },
      { query: 'when does the dispatcher drain' },
      { identity: RECALL_SESSION, now: LATER },
    );
    await sideEffects.whenIdle();

    const served = (pack.facts ?? []).map((entry) => entry.id);
    const withheld = served.includes(RECALL_FIRST) ? RECALL_SECOND : RECALL_FIRST;
    expect(served).toHaveLength(1);
    expect([RECALL_FIRST, RECALL_SECOND]).toContain(served[0]);
    expect(pack.metadata.suppressed_duplicates).toBe(1);

    expect(completion?.retrieved).toEqual(expect.arrayContaining([RECALL_FIRST, RECALL_SECOND]));
    expect([...(completion?.emitted ?? [])]).toEqual(served);
    expect((await accessMetadata(harness.driver, served[0] ?? '')).accessCount).toBe(1);
    expect(await accessMetadata(harness.driver, withheld)).toEqual({});
  });
});
