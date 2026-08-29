import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdmissionPolicy } from './admission.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { contentVectors } from '../../infrastructure/graph/seed-queries.js';
import { ensureGraphSession } from '../../infrastructure/graph/sessions.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { toGraphVector } from '../../infrastructure/graph/values.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { fuse, type FusionCandidate, type RankedList } from './fusion.js';

/**
 * The near-duplicate repro against a live substrate: a burst cluster written with a real
 * Ollama vector each, fetched back through the same `contentVectors` path production MMR
 * uses. `fusion.test.ts` already isolates the cosine leg against a hand-picked vector;
 * measuring it here against this embedding model's real output on the burst-record shape
 * found that moderately-varied full sentences do NOT collapse the way degenerate short
 * strings do (a first pass at 12-word sentences left 7 of 8 distinct above 0.95), so this
 * fixture keeps the one-line template shape that was actually measured: short enough that
 * the model's own noise floor, not deliberate paraphrase, is what would separate two burst
 * records. `fuse` is a pure domain function, so nothing here needs a session or containment
 * edge; the graph exists only to round-trip a real vector through the real read path.
 */

const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.AION_EMBED_MODEL ?? DEFAULTS.models.embed;
const SEEDED_AT = new Date('2026-06-01T00:00:00.000Z');
const SESSION_ID = 'fusion-int-cluster-session';

const ADMIT_ALL: AdmissionPolicy = { vectorFloor: 0, corroborationFloor: 0, bm25Mode: 'any' };

const BURST_TEXT = Array.from({ length: 8 }, (_, worker) => `restart burst 0/${String(worker)}`);

const DISTINCT_TEXT = [
  'the migration deadlocked on a read-only join across two tables',
  'redis backs the session cache for the platform',
  'the cue model times out past eight seconds cold',
];

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let candidates: FusionCandidate[];
let vectors: ReadonlyMap<string, Vector>;

async function seedEpisode(provider: OllamaProvider, text: string): Promise<FusionCandidate> {
  const [embedding] = await provider.embed([text]);
  if (embedding === undefined) {
    throw new Error(`embedding failed for: ${text}`);
  }
  const node = await writeStampedNode(harness.driver, {
    label: 'Episode',
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: {
      [MEMORY_PROPERTIES.text]: text,
      [MEMORY_PROPERTIES.summary]: text,
      [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
      [MEMORY_PROPERTIES.contentVector]: toGraphVector(embedding),
    },
  });
  return {
    id: node.id,
    labels: ['Episode', 'Memory'],
    content: text,
    currency: 'current',
    rationale: { method: 'vector', score: 0.8 },
    relevance: 0.8,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-fusion-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Fusion Int Test' });
  await ensureGraphSession(harness.driver, {
    sessionId: SESSION_ID,
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
    now: SEEDED_AT,
  });

  const provider = new OllamaProvider({ baseUrl: OLLAMA_URL, embedModel: EMBED_MODEL });
  const seeded: FusionCandidate[] = [];
  for (const text of [...BURST_TEXT, ...DISTINCT_TEXT]) {
    seeded.push(await seedEpisode(provider, text));
  }
  candidates = seeded;

  const rows = await contentVectors(harness.driver, {
    ids: candidates.map((candidate) => candidate.id),
    mode: withCurrency(),
  });
  vectors = new Map(rows.map((row) => [row.id, row.vector]));
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the near-duplicate cluster cap against real embeddings', () => {
  it('caps the burst cluster and keeps every distinct episode', () => {
    const list: RankedList = { leg: 'vector', weight: 1, candidates };
    const result = fuse([list], {
      rrfConstant: 60,
      admission: ADMIT_ALL,
      reranker: 'rrf',
      mmrLambda: 0.5,
      clusterCap: DEFAULTS.recall.clusterCap,
      vectors,
    });

    const burstIds = new Set(candidates.slice(0, BURST_TEXT.length).map((candidate) => candidate.id));
    const distinctIds = new Set(candidates.slice(BURST_TEXT.length).map((candidate) => candidate.id));
    const survivingBurst = result.items.filter((item) => burstIds.has(item.id));
    const survivingDistinct = result.items.filter((item) => distinctIds.has(item.id));

    console.log(
      `cluster cap: ${String(BURST_TEXT.length)} burst episodes -> ${String(survivingBurst.length)} survived, ` +
        `droppedNearDuplicate ${String(result.admission.droppedNearDuplicate)}, model ${EMBED_MODEL}`,
    );

    expect(survivingBurst.length).toBeLessThanOrEqual(DEFAULTS.recall.clusterCap);
    expect(survivingBurst.length).toBeGreaterThan(0);
    expect(survivingDistinct).toHaveLength(DISTINCT_TEXT.length);
    expect(result.admission.droppedNearDuplicate).toBe(BURST_TEXT.length - survivingBurst.length);
  }, 60_000);
});
