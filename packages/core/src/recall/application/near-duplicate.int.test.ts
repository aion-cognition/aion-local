import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
} from '../../infrastructure/graph/claim-key-queries.js';
import {
  normalizeCognitiveText,
  TEXT_NORM_PROPERTY,
} from '../../infrastructure/graph/cognitive-text.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { restatedClaims } from '../../infrastructure/graph/near-duplicate-queries.js';
import { knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';
import { writeSemanticRelationship } from '../../infrastructure/graph/semantic-relationship-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';

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

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

type ClaimInput = {
  readonly id: string;
  readonly text: string;
  readonly subject?: string;
  readonly aspect?: string;
  readonly keyed?: false;
  readonly at?: Date;
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
  await writeSemanticRelationship(harness.driver, {
    sourceId: 'clash-a',
    targetId: 'clash-b',
    type: 'CONTRADICTS',
    confidence: 1,
    now: LATER,
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

  it('asks nothing of the graph for a candidate set too small to hold a pair', async () => {
    expect(await restatedClaims(harness.driver, { ids: [], mode: withCurrency() })).toEqual([]);
    expect(await restatedClaims(harness.driver, { ids: ['fold-a'], mode: withCurrency() })).toEqual(
      [],
    );
  });
});
