import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import {
  fulltextSeeds,
  lucenePhraseQuery,
  vectorSeeds,
} from '../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { ReflectionDispatch } from '../../reflection/application/dispatch.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { SessionManager } from '../../session/session-manager.js';
import { CueCache } from './cues.js';
import { BATTERY_SUBSTRATE, OFF_TOPIC_BATTERY, ON_TOPIC_BATTERY } from './floors.fixtures.js';
import { handleRecall, type RecallDeps } from './recall.js';

/**
 * The paired gate, end to end on real embeddings: the floor has to starve the off-topic
 * battery without starving the on-topic hits. Half of it alone proves nothing, since a floor
 * at 1.0 passes the first half and fails everything a user would ask.
 *
 * Embeddings are the live model, because the floor is calibrated against that model and a
 * fixture vector would test arithmetic instead. Cue extraction is stubbed to the raw query so
 * the measurement is the floor rather than the cue model's judgment on the day.
 */

const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const WRITE_SESSION = 'floor-battery-write';
const READ_SESSION = 'floor-battery-read';

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');

const embedder = new OllamaProvider({
  baseUrl: OLLAMA_URL,
  embedModel: process.env.AION_EMBED_MODEL ?? DEFAULTS.models.embed,
});

/** Set by each probe; the stub returns it as the single query cue, weighted 3. */
let queryCue = '';

const provider: Provider = {
  embed: (texts) => embedder.embed(texts),
  generate: () =>
    Promise.resolve({ query_cues: [queryCue], summary_cues: [], recent_turn_cues: [] }),
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
let deps: RecallDeps;
const storedIds = new Map<string, string>();

type PackShape = {
  readonly items: number;
  readonly topId: string | undefined;
  readonly topContent: string | undefined;
  /** Position of an id in the pack, best first; -1 when the pack does not carry it. */
  rankOf(id: string | undefined): number;
};

/**
 * How many of the on-topic probes have to come back ranked first. Rank is RRF's job rather
 * than the floor's, which decides only what may compete at all, so the per-probe assertion
 * is that the answer is in the pack, and this is the aggregate that catches a floor which
 * kept the answer but buried it.
 */
const MIN_RANK_ONE_RATE = 0.75;

type ProbeRow = {
  readonly query: string;
  readonly items: number;
  readonly rank: number;
};

const onTopicRows: ProbeRow[] = [];

async function waitFor(label: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function probe(query: string): Promise<PackShape> {
  queryCue = query;
  const pack = await handleRecall(
    { ...deps, cueCache: new CueCache() },
    { query },
    { identity: READ_SESSION, now: RECALLED_AT },
  );
  const items = [
    ...(pack.facts ?? []),
    ...(pack.episodes ?? []),
    ...(pack.narratives ?? []),
    ...(pack.preferences ?? []),
    ...(pack.resonant ?? []),
  ];
  return {
    items: items.length,
    topId: items[0]?.id,
    topContent: items[0]?.content,
    rankOf: (id) => items.findIndex((item) => item.id === id),
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-floor-battery-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'warn' });
  await runGraphMigrations(harness.driver, db, {
    embedDimension: DEFAULTS.models.embedDimension,
  });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });

  deps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config: DEFAULTS,
    cueCache: new CueCache(),
    logger,
  };

  for (const [index, episode] of BATTERY_SUBSTRATE.entries()) {
    const result = await handleReflection(
      {
        driver: harness.driver,
        db,
        sessions,
        provider,
        dispatch: new ReflectionDispatch(),
        logger,
        entropyThreshold: DEFAULTS.redaction.entropyThreshold,
        lanes: new LaneAssigner(DEFAULTS.lanes),
      },
      { observations: [episode.observation] },
      { identity: WRITE_SESSION, now: new Date(STORED_AT.getTime() + index * 60_000) },
    );
    storedIds.set(episode.id, result.episode_id);
  }

  // Both indexes are eventually consistent, and a probe that runs while one is still catching
  // up measures index lag rather than the floor. Every episode is checked, not a sample:
  // a partially indexed substrate reorders packs run to run.
  await waitFor('the fulltext index to cover every episode', async () => {
    for (const episode of BATTERY_SUBSTRATE) {
      const rows = await fulltextSeeds(harness.driver, {
        query: lucenePhraseQuery(episode.observation),
        limit: 10,
        mode: withCurrency(),
      });
      if (!rows.some((row) => row.id === storedIds.get(episode.id))) {
        return false;
      }
    }
    return true;
  });

  await waitFor('the vector index to cover every episode', async () => {
    const [vector] = await provider.embed(['orders table sharding decision']);
    if (vector === undefined) {
      return false;
    }
    const rows = await vectorSeeds(harness.driver, {
      vector,
      limit: BATTERY_SUBSTRATE.length * 2,
      mode: withCurrency(),
    });
    return rows.length >= BATTERY_SUBSTRATE.length;
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the off-topic battery that used to fill a pack to budget', () => {
  it.each(OFF_TOPIC_BATTERY)('returns a thin or empty pack for: %s', async (query) => {
    const shape = await probe(query);
    console.log(`off-topic "${query}": ${String(shape.items)} items`);
    expect(shape.items).toBe(0);
  }, 60_000);
});

describe('the paired on-topic battery', () => {
  it.each(ON_TOPIC_BATTERY)('still answers: $query', async (entry) => {
    const shape = await probe(entry.query);
    const rank = shape.rankOf(storedIds.get(entry.expects));
    onTopicRows.push({ query: entry.query, items: shape.items, rank });
    console.log(
      `on-topic "${entry.query}": ${String(shape.items)} items, answer at rank ` +
        `${String(rank + 1)}${rank === 0 ? '' : `, top: ${String(shape.topContent)}`}`,
    );
    expect(shape.items).toBeGreaterThan(0);
    expect(rank).toBeGreaterThanOrEqual(0);
  }, 60_000);

  // Last, so every probe above has already pushed its row.
  it('keeps most of them ranked first, not merely admitted', () => {
    const first = onTopicRows.filter((row) => row.rank === 0).length;
    console.log(
      `on-topic rank-1 rate: ${String(first)}/${String(onTopicRows.length)}, ` +
        `ranks ${onTopicRows.map((row) => row.rank + 1).join(' ')}`,
    );

    expect(onTopicRows).toHaveLength(ON_TOPIC_BATTERY.length);
    expect(first / onTopicRows.length).toBeGreaterThanOrEqual(MIN_RANK_ONE_RATE);
  });
});
