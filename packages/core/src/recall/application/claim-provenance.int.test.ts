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
import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import {
  normalizeCognitiveText,
  TEXT_NORM_PROPERTY,
} from '../../infrastructure/graph/cognitive-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { fetchNodeProvenance } from '../../infrastructure/graph/node-provenance.js';
import { knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';
import { vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The source record a pack carries, end to end: a caller states where an experience came from
 * and what it corrects, and a later recall renders those statements as what they are.
 *
 * The graph is hand-built where the shape is the subject and pushed through reflection where
 * the reference handling is. Content vectors are written rather than embedded: what is under
 * test is the provenance contract, not extraction quality or the embedding model.
 */

const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';

const SEEDED_AT = new Date('2026-06-01T09:00:00.000Z');
const SUPERSEDED_AT = new Date('2026-06-05T09:00:00.000Z');
const BEFORE_SUPERSESSION = new Date('2026-06-03T09:00:00.000Z');
const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

const QUERY = 'how does the ingest queue drain';

const ROOT_ID = 'prov-root-episode';
const TURN_EPISODE_ID = 'prov-turn-episode';
const TURN_ID = 'prov-stale-turn';
const OLD_CLAIM_ID = 'prov-old-claim';
const NEW_CLAIM_ID = 'prov-new-claim';

// Each pushed observation opens with its own marker. The near-duplicate cap keys on the first
// sixteen characters of an item's content, and every observation renders under one prefix, so
// three that opened alike would be one cluster and the cap would drop the third.
const ALPHA_MARKER = 'alphaward';
const BETA_MARKER = 'betaward';
const CORRECTION_MARKER = 'gammaward';
const CONFIRMER_MARKER = 'deltaward';

const CONFIRMER = 'Ryan Huber';
const CONFIRMATION_EVIDENCE = 'review thread 41';

/**
 * Every node shares one strong component with the cue and carries a distinct axis of its own,
 * so all of them clear the vector floor and no two sit close enough for near-duplicate
 * suppression to fold them together.
 */
function unit(axis: number, shared = 0.7): Vector {
  const raw = new Array<number>(EMBED_DIMENSION).fill(0.001);
  raw[0] = shared;
  raw[axis] = 0.7;
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

const CUE_VECTOR = unit(0, 0.99);
/** Off the shared axis entirely, so the turn's own episode never reaches the pack. */
const OFF_TOPIC = unit(7, 0.001);

const VECTORS: Readonly<Record<string, Vector>> = {
  root: unit(1),
  alpha: unit(2),
  beta: unit(3),
  correction: unit(4),
  turn: unit(5),
  oldClaim: unit(6),
  newClaim: unit(7),
};

function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  if (lowered.includes(ALPHA_MARKER)) {
    return VECTORS.alpha ?? CUE_VECTOR;
  }
  if (lowered.includes(BETA_MARKER)) {
    return VECTORS.beta ?? CUE_VECTOR;
  }
  if (lowered.includes(CORRECTION_MARKER)) {
    return VECTORS.correction ?? CUE_VECTOR;
  }
  if (lowered.includes(CONFIRMER_MARKER)) {
    return OFF_TOPIC;
  }
  return CUE_VECTOR;
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

function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, vectorLimit: 20, tokenBudget: 6000 },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let deps: RecallDeps;
let alphaId: string;
let betaId: string;
let correctionId: string;
let confirmerId: string;

type StatedReferences = {
  readonly supersedes?: readonly string[];
  readonly derived_from?: readonly string[];
  readonly confirmations?: readonly {
    readonly target: string;
    readonly by: string;
    readonly evidence: string;
  }[];
};

async function push(
  observation: string,
  identity: string,
  provenance?: StatedReferences,
): Promise<string> {
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
      acceptHookCapture: true,
    },
    { observations: [observation], ...(provenance === undefined ? {} : { provenance }) },
    { identity, now: SEEDED_AT },
  );
  return result.episode_id;
}

async function writeEpisode(id: string, text: string, vector: Vector): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: {
      text,
      session_id: `${id}-session`,
      content_vec: [...vector],
    },
  });
}

async function writeClaim(id: string, text: string, vector: Vector): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: {
      text,
      [TEXT_NORM_PROPERTY]: normalizeCognitiveText(text),
      content_vec: [...vector],
    },
  });
}

async function recall(identity: string, payload: Record<string, unknown> = {}) {
  return handleRecall(deps, { query: QUERY, ...payload }, { identity, now: RECALLED_AT });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-claim-provenance-int-'));
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

  await writeEpisode(
    ROOT_ID,
    'root capture: the ingest queue drain design review',
    VECTORS.root ?? CUE_VECTOR,
  );
  await writeEpisode(TURN_EPISODE_ID, 'an unrelated capture', OFF_TOPIC);

  await writeStampedNode(harness.driver, {
    label: 'Turn',
    id: TURN_ID,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: {
      text: 'the ingest queue drains itself overnight without a worker',
      role: 'user',
      sequence: 1,
      session_id: `${TURN_EPISODE_ID}-session`,
      source_episode_id: TURN_EPISODE_ID,
      extraction_method: 'reflection_intake',
      content_vec: [...(VECTORS.turn ?? CUE_VECTOR)],
    },
  });

  await writeClaim(
    OLD_CLAIM_ID,
    'the ingest queue drain rate was capped at 200 rows a second',
    VECTORS.oldClaim ?? CUE_VECTOR,
  );
  await writeClaim(
    NEW_CLAIM_ID,
    'the ingest queue drain rate is capped at 900 rows a second',
    VECTORS.newClaim ?? CUE_VECTOR,
  );
  await supersede(harness.driver, {
    oldId: OLD_CLAIM_ID,
    newId: NEW_CLAIM_ID,
    now: SUPERSEDED_AT,
  });

  alphaId = await push(
    `${ALPHA_MARKER} drains the ingest queue through a webhook worker`,
    'prov-session-alpha',
    { derived_from: [ROOT_ID] },
  );
  betaId = await push(
    `${BETA_MARKER} samples the ingest queue drain rate hourly`,
    'prov-session-beta',
    { derived_from: [ROOT_ID] },
  );
  correctionId = await push(
    `${CORRECTION_MARKER} means the ingest queue needs a worker to drain at all`,
    'prov-session-correction',
    { supersedes: [TURN_ID], derived_from: ['prov-nothing-holds-this'] },
  );
  confirmerId = await push(`${CONFIRMER_MARKER} notes the drain path`, 'prov-session-confirm', {
    confirmations: [{ target: alphaId, by: CONFIRMER, evidence: CONFIRMATION_EVIDENCE }],
  });

  // Every node the assertions read has to be reachable by the vector leg before the first
  // recall runs: the index is eventually consistent, and a probe that runs while it catches up
  // measures the lag rather than the pack.
  await waitFor('the vector index to cover every written node', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: CUE_VECTOR,
      limit: 40,
      mode: withCurrency(),
    });
    const found = new Set(rows.map((row) => row.id));
    return [
      ROOT_ID,
      TURN_ID,
      OLD_CLAIM_ID,
      NEW_CLAIM_ID,
      alphaId,
      betaId,
      correctionId,
      confirmerId,
    ].every((id) => found.has(id));
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('two memories that name one source', () => {
  it('exposes the shared origin rather than serving them as two witnesses', async () => {
    const pack = await recall('prov-read-shared');
    const episodes = pack.episodes ?? [];

    const alpha = episodes.find((entry) => entry.id === alphaId);
    const beta = episodes.find((entry) => entry.id === betaId);
    expect(alpha?.derivation?.roots).toEqual([ROOT_ID]);
    expect(beta?.derivation?.roots).toEqual([ROOT_ID]);

    const shared = episodes.filter((entry) => entry.derivation?.shared_with !== undefined);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.derivation?.shared_with).toEqual([
      shared[0]?.id === alphaId ? betaId : alphaId,
    ]);
    expect(pack.rendered_text).toContain('not independent corroboration');
  });

  it('marks the lineage short when a stated source resolved to nothing', async () => {
    const pack = await recall('prov-read-incomplete');
    const correction = (pack.episodes ?? []).find((entry) => entry.id === correctionId);

    expect(correction?.derivation?.complete).toBe(false);
    expect(pack.rendered_text).toContain('lineage incomplete');
  });
});

describe('what the substrate can say about who stands behind a line', () => {
  it('prints the recorded role and still calls the authorship unknown', async () => {
    const pack = await recall('prov-read-authorship');
    const turn = (pack.episodes ?? []).find((entry) => entry.id === TURN_ID);

    expect(turn?.standing?.kind).toBe('recorded_utterance');
    expect(turn?.standing?.recorded_role).toBe('user');
    expect(turn?.standing?.attribution).toBe('reported');
    expect(turn?.standing?.confirmed).toBeUndefined();
    expect(pack.rendered_text).toContain('recorded role user, authorship unknown');
  });

  it('names the confirmer only where a confirmation record cites its evidence', async () => {
    const pack = await recall('prov-read-confirmed');
    const alpha = (pack.episodes ?? []).find((entry) => entry.id === alphaId);

    expect(alpha?.standing?.attribution).toBe('attributed');
    expect(alpha?.standing?.confirmed?.by).toBe(CONFIRMER);
    expect(alpha?.standing?.confirmed?.evidence).toBe(CONFIRMATION_EVIDENCE);
    expect(pack.rendered_text).toContain(
      `confirmed by ${CONFIRMER} at 2026-06-01T09:00:00.000Z, evidence: ${CONFIRMATION_EVIDENCE}`,
    );
  });
});

describe('a raw turn somebody stated a correction against', () => {
  it('routes the correction to lineage and closes nothing', async () => {
    const pack = await recall('prov-read-correction');
    const turn = (pack.episodes ?? []).find((entry) => entry.id === TURN_ID);

    expect(turn?.claimed_correction?.by).toBe(correctionId);
    expect(pack.rendered_text).toContain('nothing has closed it');

    // The node itself is untouched: a reference the caller supplied is evidence for the judge,
    // never a close on its own.
    const stored = await fetchNodeProvenance(harness.driver, TURN_ID, withCurrency(RECALLED_AT));
    expect(stored?.currency).toBe('current');
    expect(stored?.supersededBy).toBeUndefined();
    expect(turn?.currency).toBe('current');
  });
});

describe('superseded material', () => {
  it('serves the successor first and marks history the pack is not holding', async () => {
    const pack = await recall('prov-read-superseded');
    const facts = pack.facts ?? [];
    const oldIndex = facts.findIndex((entry) => entry.id === OLD_CLAIM_ID);
    const newIndex = facts.findIndex((entry) => entry.id === NEW_CLAIM_ID);

    expect(oldIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeLessThan(oldIndex);
    expect(facts[oldIndex]?.currency).toBe('superseded');
    expect(facts[oldIndex]?.successor_absent).toBeUndefined();
  });

  it('stays reachable at its own vantage point, unmarked and in its own place', async () => {
    const pack = await recall('prov-read-historical', {
      knew_at: BEFORE_SUPERSESSION.toISOString(),
    });
    const old = (pack.facts ?? []).find((entry) => entry.id === OLD_CLAIM_ID);

    expect(old?.currency).toBe('current');
    expect(old?.successor_absent).toBeUndefined();
    expect(pack.rendered_text).not.toContain('successor not served');

    // Same read against the graph directly, so the pack's answer is the substrate's answer.
    const stored = await fetchNodeProvenance(
      harness.driver,
      OLD_CLAIM_ID,
      knewAt(BEFORE_SUPERSESSION),
    );
    expect(stored?.currency).toBe('current');
  });
});

describe('a memory whose standing moved after the session read it', () => {
  const SESSION = 'prov-read-restanding';

  it('re-serves the line once somebody confirms it', async () => {
    const first = await recall(SESSION);
    expect((first.episodes ?? []).map((entry) => entry.id)).toContain(betaId);

    // Nothing changed in between, so the session already holds it.
    const second = await recall(SESSION);
    expect((second.episodes ?? []).map((entry) => entry.id)).not.toContain(betaId);

    await push('a later note confirming the sampling interval', 'prov-session-confirm-beta', {
      confirmations: [{ target: betaId, by: CONFIRMER, evidence: 'standup notes' }],
    });

    const third = await recall(SESSION);
    const beta = (third.episodes ?? []).find((entry) => entry.id === betaId);
    expect(beta?.standing?.confirmed?.evidence).toBe('standup notes');
  });
});
