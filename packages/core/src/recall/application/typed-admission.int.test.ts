import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { fulltextSeeds, vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import { writeSemanticRelationship } from '../../infrastructure/graph/semantic-relationship-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The typed-admission tier, on a real graph and a real gate. A CONTRADICTS partner sits at
 * cosine 0.56 against the cue: under the 0.6 vector floor, over the 0.55 corroboration floor,
 * and reachable only through the edge this test writes directly, so no seed strategy and no
 * ordinary traversal path can be what admits it.
 */

const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';
const ANCHOR_WRITE_SESSION = 'typed-admission-anchor-write';
const PARTNER_WRITE_SESSION = 'typed-admission-partner-write';
const READ_SESSION = 'typed-admission-read';

const STARTED_AT = new Date('2026-06-01T09:00:00.000Z');
const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

const QUERY = 'why did the outage recur';
const CUE = 'outage';

/** Names the subject, so every retrieval leg finds it. The only seed the run gets. */
const ANCHOR_TEXT = 'the outage recurred because the retry queue never drained';

/**
 * Contradicts the anchor's claim, but says nothing that names the subject or resembles it
 * lexically: no seed strategy can reach it, and its cosine to the cue sits at 0.56, under the
 * 0.6 vector floor. Written to a session of its own, so a PARTICIPATES_IN path through a shared
 * session cannot be what reaches it either; the CONTRADICTS edge this test writes is the only
 * way in.
 */
const PARTNER_TEXT = 'the retry queue was in fact draining fine; something else caused it';

/** cos(0, axis) = 0.56 exactly: axis(0)*0.56 + axis(2)*sqrt(1-0.56^2), both unit vectors. */
const PARTNER_COSINE = 0.56;

function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

function blended(cosine: number): Vector {
  const vector = axis(0).map((value) => value * cosine);
  vector[2] = Math.sqrt(1 - cosine * cosine);
  return vector;
}

/**
 * Cue extraction hands the pipeline both the model's own cue and the raw query text as a
 * second, separately weighted cue (`cues.ts`). Mapping the whole query sentence to the exact
 * same vector as the one-word cue would measure the partner twice at the same cosine under two
 * cue strings, which corroboration counts as two independent measurements and admits on its
 * own, before the typed tier ever runs. Only the exact cue text and the anchor's own content
 * (stored with an `observation: ` prefix, hence the substring check rather than equality)
 * resolve to the cue's axis; the raw query sentence resolves to an unrelated direction instead,
 * same as a real embedding model would never place a whole sentence exactly atop one word.
 */
function vectorFor(text: string): Vector {
  if (text === CUE || text.includes(ANCHOR_TEXT)) {
    return axis(0);
  }
  if (text.includes(PARTNER_TEXT)) {
    return blended(PARTNER_COSINE);
  }
  return axis(1);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

/**
 * `vectorLimit` and `seedLimit` at 1 so vector search and the recency leg both return only the
 * anchor: the partner has to reach the pack through the spread alone. Both session subtractions
 * are off so a repeat recall in the same session measures the same thing twice.
 */
function config(overrides: Partial<Config['recall']> = {}): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: {
      ...DEFAULTS.recall,
      vectorLimit: 1,
      sessionDedup: false,
      ownSessionFilter: false,
      // The fixture's cosines are placed against these pinned floors so the mechanism test survives recalibration of the shipped defaults.
      vectorAdmissionFloor: 0.6,
      corroborationFloor: 0.55,
      ...overrides,
    },
    contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 1 },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let deps: RecallDeps;
let anchorEpisodeId: string;
let partnerEpisodeId: string;

async function push(observation: string, identity: string, now: Date): Promise<string> {
  const result = await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions: deps.sessions,
      provider,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    },
    { observations: [observation] },
    { identity, now },
  );
  return result.episode_id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-typed-admission-int-'));
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

  // The partner is written first (older) and to its own session, so nothing but the explicit
  // edge below connects it to the anchor; the anchor is written last, so it is also the node
  // vector search and the recency leg both pick at this budget.
  partnerEpisodeId = await push(PARTNER_TEXT, PARTNER_WRITE_SESSION, STARTED_AT);
  anchorEpisodeId = await push(
    ANCHOR_TEXT,
    ANCHOR_WRITE_SESSION,
    new Date(STARTED_AT.getTime() + 120_000),
  );

  await writeSemanticRelationship(harness.driver, {
    type: 'CONTRADICTS',
    sourceId: anchorEpisodeId,
    targetId: partnerEpisodeId,
    confidence: 1,
    now: new Date(STARTED_AT.getTime() + 180_000),
  });

  await waitFor('the vector index to cover both episodes', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(1),
      limit: 10,
      mode: withCurrency(),
    });
    return rows.length >= 2;
  });

  await waitFor('the fulltext index to cover the anchor episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === anchorEpisodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a CONTRADICTS partner under the vector floor', () => {
  it('is out of reach of every retrieval leg at this budget', async () => {
    const nearest = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: config().recall.vectorLimit,
      mode: withCurrency(),
    });
    expect(nearest.map((row) => row.id)).toEqual([anchorEpisodeId]);

    const lexical = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    expect(lexical.map((row) => row.id)).not.toContain(partnerEpisodeId);
  });

  it('reaches the pack on typed evidence, named by the edge and the cosine it cleared', async () => {
    const pack = await handleRecall(
      deps,
      { query: QUERY },
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    const partner = pack.episodes?.find((item) => item.id === partnerEpisodeId);
    expect(partner?.rationale.method).toBe('activation');
    expect(partner?.admitted_by?.rule).toBe('typed_admission');
    expect(partner?.admitted_by?.evidence).toContain('typed-edge: CONTRADICTS');
    expect(partner?.confidence).toBeCloseTo(PARTNER_COSINE, 2);
    expect(pack.metadata.admission.typed_admitted).toBe(1);

    const anchor = pack.episodes?.find((item) => item.id === anchorEpisodeId);
    expect(anchor?.rationale.method).not.toBe('activation');
  });

  it('writes a permanent ledger row naming the edge, the cosine, and both floors', async () => {
    await handleRecall(deps, { query: QUERY }, { identity: READ_SESSION, now: RECALLED_AT });

    const entry = getLedgerEntry(
      db,
      `typed_admission:${READ_SESSION}:${RECALLED_AT.toISOString()}:${partnerEpisodeId}`,
    );
    expect(entry?.summary).toEqual({
      itemId: partnerEpisodeId,
      edgeType: 'CONTRADICTS',
      typedContribution: expect.any(Number),
      activationFloor: DEFAULTS.recall.typedAdmissionActivationFloor,
      activationScore: expect.any(Number),
      cosine: expect.closeTo(PARTNER_COSINE, 2),
      clearedFloor: 0.55,
      failedFloor: 0.6,
    });
  });

  it('restores single-tier admission exactly when the kill switch is off', async () => {
    const offDeps: RecallDeps = { ...deps, config: config({ typedAdmission: false }) };
    const pack = await handleRecall(
      offDeps,
      { query: QUERY },
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    expect(pack.episodes?.map((item) => item.id)).not.toContain(partnerEpisodeId);
    expect(pack.metadata.admission.typed_admitted ?? 0).toBe(0);
  });
});
