import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import {
  normalizeCognitiveText,
  TEXT_NORM_PROPERTY,
} from '../../infrastructure/graph/cognitive-queries.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { ENTITY_MENTION_TYPE } from '../../infrastructure/graph/entity-queries.js';
import { CONTAINMENT_TYPE } from '../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { findRelatedClaims } from '../../infrastructure/graph/related-claim-queries.js';
import type { RelationshipType } from '../../infrastructure/graph/relationships.js';
import { fulltextSeeds, vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * A belief stated in a turn, corrected later in a claim, and surfaced afterwards by resonance
 * alone.
 *
 * That is the shape the substrate has no answer for on its own. A Turn is captured text, so
 * cognitive extraction never distils it into a claim and supersession, which judges extracted
 * nodes, never gets a candidate pair. The turn keeps answering as current. A direct question
 * co-retrieves the correction and the reading agent arbitrates fine; resonance surfaces the
 * turn with nothing around it, and the pack then carries a contradicted sentence stated
 * plainly.
 *
 * The graph is hand-built, and the two content vectors that have to look alike are written
 * rather than embedded: what is under test is the family query and the annotation, not
 * extraction quality or the embedding model.
 */

const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';
const READ_SESSION = 'related-claims-session-read';

const AT = new Date('2026-06-01T09:00:00.000Z');
const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

const QUERY = 'why did we pick webhooks for ingestion';

const ANCHOR_ID = 'related-anchor';
const CAPTURE_EPISODE_ID = 'related-capture-episode';
const CORRECTION_EPISODE_ID = 'related-correction-episode';
const CLOSED_EPISODE_ID = 'related-closed-episode';
const SUBJECT_ID = 'related-subject-entity';
const STALE_TURN_ID = 'related-stale-turn';
const ORPHAN_TURN_ID = 'related-orphan-turn';
const CORRECTION_ID = 'related-correction-claim';
const SIBLING_ID = 'related-sibling-claim';
const CLOSED_ID = 'related-closed-claim';

const ANCHOR_TEXT = 'we picked webhooks for the ingestion service because polling was too slow';
/** The planted belief. It shares no term with the query, so only resonance can reach it. */
const STALE_TEXT =
  'background shell tasks are a reliable overnight fallback on this machine, and a plain until-loop survives';
const ORPHAN_TEXT = 'the espresso machine on the third floor needs descaling every fortnight';
const CORRECTION_TEXT =
  'Background shell tasks are not reliable for overnight operation on this machine, because the system reaps them.';
/** Extracted from the turn's own episode, so it restates the turn rather than answering it. */
const SIBLING_TEXT = 'Background shell tasks survive an overnight run on this machine.';
/** Already closed. A superseded claim is not what the substrate currently says. */
const CLOSED_TEXT = 'Background shell tasks are the standard overnight fallback here.';

const SUBJECT_NAME = 'background shell tasks';

/**
 * Small, fractional components only. The vector index property is FLOAT-typed and a
 * whole-number JS value risks the driver encoding it as a Cypher INTEGER, so no component is
 * ever exactly zero or one.
 */
function unit(components: Readonly<Record<number, number>>): Vector {
  const raw = new Array<number>(EMBED_DIMENSION).fill(0.001);
  for (const [index, value] of Object.entries(components)) {
    raw[Number(index)] = value;
  }
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

/** The query's subject. The anchor is about it; nothing else in the graph is. */
const SUBJECT = unit({ 0: 0.99 });
/** The belief's own axis, orthogonal to the query, so no content leg can reach the turn. */
const BELIEF = unit({ 1: 0.99 });
const CORRECTION = unit({ 1: 0.9, 5: 0.4 });
/** Nearer the turn than the correction is, so the ranking alone would prefer these two. */
const SIBLING = unit({ 1: 0.99 });
const CLOSED = unit({ 1: 0.98, 5: 0.1 });
const ESPRESSO = unit({ 2: 0.99 });
const SUBJECT_GLOSS = unit({ 6: 0.99 });

/** One neighborhood shape. The anchor and the two turns share it and nothing else does. */
const SHAPE = unit({ 4: 0.99 });
const NEARBY_SHAPE = unit({ 4: 0.95, 7: 0.3 });

function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  if (lowered.includes('webhook') || lowered.includes('ingestion')) {
    return SUBJECT;
  }
  if (lowered.includes('espresso')) {
    return ESPRESSO;
  }
  return unit({ 3: 0.99 });
}

/** The query text as the cue model would hand it back: one query cue, the caller's own words. */
function queryOf(request: StructuredRequest): string {
  const user = request.messages.find((message) => message.role === 'user');
  const match = /Query:\n(.*)/.exec(user?.content ?? '');
  return match?.[1]?.trim() ?? '';
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: (request) =>
    Promise.resolve({
      query_cues: [queryOf(request)],
      summary_cues: [],
      recent_turn_cues: [],
    }),
};

/**
 * One seed and one row per leg, the narrow budget the resonance scenario uses: at the shipped
 * budget every node in a graph this small is a seed, the exclusion set swallows the substrate,
 * and nothing is left for the second pass to discover.
 */
function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, vectorLimit: 1 },
    contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 1 },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let deps: RecallDeps;

async function waitFor(label: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function writeEpisode(id: string, text: string, at: Date, context?: Vector): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: at,
    occurredAt: at,
    properties: {
      text,
      session_id: `${id}-session`,
      content_vec: [...vectorFor(text)],
      ...(context === undefined ? {} : { context_vec: [...context] }),
    },
  });
}

async function writeTurn(
  id: string,
  episodeId: string,
  text: string,
  content: Vector,
  context: Vector,
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Turn',
    id,
    now: AT,
    occurredAt: AT,
    properties: {
      text,
      role: 'assistant',
      sequence: 1,
      session_id: `${episodeId}-session`,
      source_episode_id: episodeId,
      extraction_method: 'reflection_intake',
      content_vec: [...content],
      context_vec: [...context],
    },
  });
  await link(CONTAINMENT_TYPE, id, episodeId);
}

async function writeClaim(
  id: string,
  episodeId: string,
  text: string,
  content: Vector,
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id,
    now: AT,
    occurredAt: AT,
    properties: {
      text,
      [TEXT_NORM_PROPERTY]: normalizeCognitiveText(text),
      content_vec: [...content],
    },
  });
  await link('EXTRACTED_FROM', id, episodeId);
}

async function link(type: RelationshipType, sourceId: string, targetId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type,
    sourceId,
    targetId,
    strength: 1,
    confidence: 0.9,
    signals: ['episodic'],
    provenance: ['test-fixture'],
    count: 1,
    now: AT,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-related-claims-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  deps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider,
    config: config(),
    cueCache: new CueCache(),
    logger,
  };

  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id: SUBJECT_ID,
    now: AT,
    occurredAt: AT,
    properties: {
      name: SUBJECT_NAME,
      name_norm: SUBJECT_NAME,
      type: 'concept',
      text: `${SUBJECT_NAME} (concept): work started from a shell and left running`,
      content_vec: [...SUBJECT_GLOSS],
    },
  });

  await writeEpisode(CAPTURE_EPISODE_ID, 'a session about the paper title', AT);
  await writeEpisode(CORRECTION_EPISODE_ID, 'a session about the overnight run', AT);
  await writeEpisode(CLOSED_EPISODE_ID, 'an earlier session about the overnight run', AT);
  await link(ENTITY_MENTION_TYPE, CORRECTION_EPISODE_ID, SUBJECT_ID);
  await link(ENTITY_MENTION_TYPE, CLOSED_EPISODE_ID, SUBJECT_ID);

  await writeTurn(STALE_TURN_ID, CAPTURE_EPISODE_ID, STALE_TEXT, BELIEF, SHAPE);
  await writeTurn(ORPHAN_TURN_ID, CAPTURE_EPISODE_ID, ORPHAN_TEXT, ESPRESSO, NEARBY_SHAPE);

  await writeClaim(CORRECTION_ID, CORRECTION_EPISODE_ID, CORRECTION_TEXT, CORRECTION);
  await writeClaim(SIBLING_ID, CAPTURE_EPISODE_ID, SIBLING_TEXT, SIBLING);
  await writeClaim(CLOSED_ID, CLOSED_EPISODE_ID, CLOSED_TEXT, CLOSED);
  await supersede(harness.driver, { oldId: CLOSED_ID, newId: CORRECTION_ID, now: AT });

  // Written last so it is also the newest node: at this budget the recency leg reads one row,
  // and a recency hit on anything else would seed what the second pass has to find on its own.
  await writeEpisode(ANCHOR_ID, ANCHOR_TEXT, new Date(AT.getTime() + 180_000), SHAPE);

  await waitFor('the vector index to cover every written node', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: BELIEF,
      limit: 20,
      mode: withCurrency(),
    });
    return rows.length >= 9;
  });

  await waitFor('the fulltext index to cover the anchor episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: 'webhooks',
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === ANCHOR_ID);
  });
  // The context vector index is eventually consistent; a probe that runs while it catches up
  // measures the lag rather than the second pass.
  await new Promise((resolve) => {
    setTimeout(resolve, 2000);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the family a raw turn belongs to', () => {
  it('answers with the current claim from another episode and nothing else', async () => {
    const rows = await findRelatedClaims(harness.driver, {
      turns: [
        { id: STALE_TURN_ID, textNorm: normalizeCognitiveText(STALE_TEXT) },
        { id: ORPHAN_TURN_ID, textNorm: normalizeCognitiveText(ORPHAN_TEXT) },
      ],
      floor: config().recall.relatedClaimFloor,
      mode: withCurrency(),
    });

    // One row for the turn that names a subject, none for the turn that names none. The two
    // nearer claims are passed over on purpose: one was extracted from the turn's own episode
    // and restates it, and the other is already closed.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turnId).toBe(STALE_TURN_ID);
    expect(rows[0]?.id).toBe(CORRECTION_ID);
    expect(rows[0]?.relatedness).toBeGreaterThan(config().recall.relatedClaimFloor);
  });

  it('leaves the turn unannotated when nothing in the family clears the floor', async () => {
    const rows = await findRelatedClaims(harness.driver, {
      turns: [{ id: STALE_TURN_ID, textNorm: normalizeCognitiveText(STALE_TEXT) }],
      floor: 0.99,
      mode: withCurrency(),
    });

    expect(rows).toEqual([]);
  });
});

describe('a stale belief surfaced by resonance alone', () => {
  /** The claim is worth nothing unless the turn is genuinely out of reach of the first pass. */
  it('is unreachable by content and by keyword', async () => {
    const nearest = await vectorSeeds(harness.driver, {
      vector: SUBJECT,
      limit: config().recall.vectorLimit,
      mode: withCurrency(),
    });
    expect(nearest.map((row) => row.id)).toEqual([ANCHOR_ID]);

    const lexical = await fulltextSeeds(harness.driver, {
      query: QUERY,
      limit: 10,
      mode: withCurrency(),
    });
    expect(lexical.map((row) => row.id)).not.toContain(STALE_TURN_ID);
  });

  it('comes back in the resonant bucket carrying the current claim about its subject', async () => {
    const pack = await handleRecall(
      deps,
      { query: QUERY },
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    expect(pack.resonant?.map((item) => item.id)).toEqual([STALE_TURN_ID]);
    expect(pack.resonant?.[0]?.related_claim?.id).toBe(CORRECTION_ID);
    expect(pack.rendered_text).toContain(
      `current related claim: ${CORRECTION_TEXT} [${CORRECTION_ID}]`,
    );
  });
});
