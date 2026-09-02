import type { MemoryPack, MemoryPackItem } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { DECISION_PROBE, DECISION_SUBSTRATE } from './facts.fixtures.js';
import { OFF_TOPIC_BATTERY } from './floors.data.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import {
  fulltextSeeds,
  lucenePhraseQuery,
  vectorSeeds,
} from '../../infrastructure/graph/seed-queries.js';
import { ensureGraphSession } from '../../infrastructure/graph/sessions.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { toGraphVector } from '../../infrastructure/graph/values.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The measured facts-bucket scenario, end to end on real embeddings. The substrate holds the
 * Decision that answers "what did we decide about the remittance ingest transport and why",
 * the Goal that restated the question, and the entity glosses that took 58% of the fact slots.
 * The measured run served the Goal at facts rank 1 and the Decision in none of the five
 * queries that asked for the transport decision.
 *
 * Claims that have to hold together, because thinning the bucket is only progress if the
 * answer survives it: the Decision reaches the top three, the restating Goal is served at no
 * rank, the glosses stay under their cap, and the off-topic battery still comes back empty.
 *
 * Cue extraction is stubbed to the cue set the pinned model returns for this query, recorded
 * from three identical live runs, so the measurement is the facts rules rather than the
 * model's mood; `cues.int.test.ts` is where the live model's own judgment is measured.
 *
 * What this substrate also shows, and what the assertions deliberately do not paper over:
 * with `recall.vectorLimit` at 5, retrieval hands fusion only the five nearest nodes per cue,
 * and a restating Goal takes one of those five on every cue. Excluding it from the bucket
 * frees a pack slot, never a retrieval slot. On a first pass this fixture carried a second
 * query-shaped Goal and the Decision sat sixth on all four cues, so no bucket rule could
 * reach it. Reserving retrieval slots is a separate problem, the one `cues.ts`'s
 * `SUMMARY_CUE_WEIGHT` measures.
 */

const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.AION_EMBED_MODEL ?? DEFAULTS.models.embed;

const SESSION_ID = 'facts-battery-write';
const READ_SESSION = 'facts-battery-read';

const SEEDED_AT = new Date('2026-06-01T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');

const embedder = new OllamaProvider({ baseUrl: OLLAMA_URL, embedModel: EMBED_MODEL });

/** Set by each probe: the cue set the pinned cue model returns for that query, recorded. */
let queryCues: readonly string[] = [];
/** Set by each probe; drives the decision-intent boost the way the live cue model would. */
let queryIntent: 'decision' | 'other' = 'other';

const provider: Provider = {
  embed: (texts) => embedder.embed(texts),
  generate: () =>
    Promise.resolve({
      query_cues: [...queryCues],
      summary_cues: [],
      recent_turn_cues: [],
      query_intent: queryIntent,
    }),
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let deps: RecallDeps;
const storedIds = new Map<string, string>();

function idOf(fixtureId: string): string {
  const id = storedIds.get(fixtureId);
  if (id === undefined) {
    throw new Error(`fixture ${fixtureId} was never stored`);
  }
  return id;
}

function allItems(pack: MemoryPack): readonly MemoryPackItem[] {
  return [
    ...(pack.facts ?? []),
    ...(pack.episodes ?? []),
    ...(pack.narratives ?? []),
    ...(pack.preferences ?? []),
    ...(pack.resonant ?? []),
  ];
}

async function probe(
  query: string,
  intent: 'decision' | 'other',
  cues: readonly string[] = [query],
): Promise<MemoryPack> {
  queryCues = cues;
  queryIntent = intent;
  return handleRecall(
    { ...deps, cueCache: new CueCache() },
    { query },
    { identity: READ_SESSION, now: RECALLED_AT },
  );
}

function decisionProbe(): Promise<MemoryPack> {
  return probe(DECISION_PROBE.query, DECISION_PROBE.intent, DECISION_PROBE.cues);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-facts-battery-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'warn' });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Facts Battery' });
  const sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  await ensureGraphSession(harness.driver, {
    sessionId: SESSION_ID,
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
    now: SEEDED_AT,
  });

  deps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    // Both session subtractions are off: the battery asks one reading session many questions, and
    // each answer is judged on what the facts bucket admits rather than on what an earlier
    // question in the same session was already handed.
    config: {
      ...DEFAULTS,
      recall: { ...DEFAULTS.recall, sessionDedup: false, ownSessionFilter: false },
    },
    cueCache: new CueCache(),
    logger,
  };

  for (const node of DECISION_SUBSTRATE) {
    const [embedding] = await provider.embed([node.content]);
    if (embedding === undefined) {
      throw new Error(`embedding failed for ${node.id}`);
    }
    const written = await writeStampedNode(harness.driver, {
      label: node.label,
      now: SEEDED_AT,
      occurredAt: SEEDED_AT,
      properties: {
        [MEMORY_PROPERTIES.text]: node.content,
        [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
        [MEMORY_PROPERTIES.contentVector]: toGraphVector(embedding),
      },
    });
    storedIds.set(node.id, written.id);
  }

  // Both indexes are eventually consistent; a probe that runs while one is catching up
  // measures index lag rather than the rules under test.
  await waitFor('the fulltext index to cover every node', async () => {
    for (const node of DECISION_SUBSTRATE) {
      const rows = await fulltextSeeds(harness.driver, {
        query: lucenePhraseQuery(node.content),
        limit: DECISION_SUBSTRATE.length * 2,
        mode: withCurrency(),
      });
      if (!rows.some((row) => row.id === idOf(node.id))) {
        return false;
      }
    }
    return true;
  });

  await waitFor('the vector index to cover every node', async () => {
    const [vector] = await provider.embed(['remittance ingest transport decision']);
    if (vector === undefined) {
      return false;
    }
    const rows = await vectorSeeds(harness.driver, {
      vector,
      limit: DECISION_SUBSTRATE.length * 2,
      mode: withCurrency(),
    });
    return rows.length >= DECISION_SUBSTRATE.length;
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the decision query', () => {
  it('puts the Decision in the top three of the facts bucket', async () => {
    const pack = await decisionProbe();
    const facts = pack.facts ?? [];
    const rank = facts.findIndex((item) => item.id === idOf(DECISION_PROBE.expects));

    console.log(
      `facts: ${facts.map((item) => `${String(item.rank)}:${item.content.slice(0, 46)}`).join(' | ')}`,
    );

    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
  }, 60_000);

  it('serves neither Goal that restates the question, at any rank', async () => {
    const pack = await decisionProbe();
    const served = new Set(allItems(pack).map((item) => item.id));

    for (const excluded of DECISION_PROBE.excludes) {
      expect(served.has(idOf(excluded))).toBe(false);
    }
  }, 60_000);

  it('holds entity glosses to the cap, leaving the bucket to content', async () => {
    const pack = await decisionProbe();
    const glossIds = new Set(
      DECISION_SUBSTRATE.filter((node) => node.label === 'Entity').map((node) => idOf(node.id)),
    );
    const glosses = (pack.facts ?? []).filter((item) => glossIds.has(item.id));

    console.log(`entity glosses served: ${String(glosses.length)} of ${String(glossIds.size)}`);
    expect(glosses.length).toBeLessThanOrEqual(DEFAULTS.recall.entityGlossCap);
  }, 60_000);

  it('renders every served item with a legible provenance line and a rising rank', async () => {
    const pack = await decisionProbe();
    const ranks = allItems(pack).map((item) => item.rank);

    expect(ranks.length).toBeGreaterThan(0);
    for (const item of allItems(pack)) {
      // A gated item renders the rule that admitted it, not a bare confidence number: the
      // two can diverge, and printing the number alone would misrepresent what actually
      // admitted the item. An ungated item still falls back to it.
      const expected =
        item.admitted_by === undefined
          ? `confidence ${item.confidence.toFixed(2)}`
          : item.admitted_by.evidence.join(' + ');
      expect(pack.rendered_text).toContain(expected);
    }
    // Within a bucket the rank is monotonic by construction. The ordering defect this guards
    // against measured 27% of adjacent pairs out of order.
    for (const bucket of [pack.facts ?? [], pack.episodes ?? []]) {
      const bucketRanks = bucket.map((item) => item.rank);
      expect(bucketRanks).toEqual([...bucketRanks].sort((left, right) => left - right));
    }
  }, 60_000);
});

describe('the floors still hold under the facts rules', () => {
  it.each(OFF_TOPIC_BATTERY)(
    'returns a thin or empty pack for: %s',
    async (query) => {
      const pack = await probe(query, 'other');
      console.log(`off-topic "${query}": ${String(allItems(pack).length)} items`);
      expect(allItems(pack)).toHaveLength(0);
    },
    60_000,
  );

  // The boost is the lever most likely to leak: a decision-shaped query against a substrate
  // that holds no answer must still come back empty rather than promoting whatever is nearest.
  it('stays empty on a decision-shaped query about an absent topic', async () => {
    const pack = await probe('what did we decide about the Reykjavik ferry timetable', 'decision');

    expect(allItems(pack)).toHaveLength(0);
  }, 60_000);
});
