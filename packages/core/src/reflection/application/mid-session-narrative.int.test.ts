import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeSessionNarrative, SessionNarrativeStage, type NarrativeDeps } from './narratives.js';
import { BITEMPORAL_PROPERTIES, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  findSessionNarratives,
  NARRATIVE_PROPERTIES,
} from '../../infrastructure/graph/narrative-queries.js';
import {
  edgeTargetId,
  nodeProperties,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { StageContext } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * A session long enough to be worth compressing before it ends. The stage runs while the
 * session is still open, the pause inside it crosses the boundary, and the close that comes
 * later versions over what the boundary wrote rather than writing a second story beside it.
 *
 * Real Neo4j because that is where the versioning lives: which episodes the session holds, what
 * the standing version covers, and the supersession that links the two.
 */

const EMBED_DIMENSION = 8;
const SESSION_ID = 'mid-session-boundary';
const QUIET_SESSION_ID = 'mid-session-boundary-switched-off';

/** Three episodes, then twenty minutes of silence, which is past the ten-minute boundary. */
const EPISODES = [
  { id: 'mid-e1', at: '2026-04-02T09:00:00.000Z' },
  { id: 'mid-e2', at: '2026-04-02T09:05:00.000Z' },
  { id: 'mid-e3', at: '2026-04-02T09:25:00.000Z' },
];

const LATE_EPISODES = [
  { id: 'mid-e4', at: '2026-04-02T09:40:00.000Z' },
  { id: 'mid-e5', at: '2026-04-02T09:45:00.000Z' },
];

/** Still inside the thirty-minute idle window, so nothing here is an idle close. */
const MID_SESSION_NOW = new Date('2026-04-02T09:30:00.000Z');
const CLOSE_NOW = new Date('2026-04-02T09:50:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;
let deps: NarrativeDeps;

function stubProvider(): Provider {
  return {
    embed: (texts) =>
      Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIMENSION }, () => 0.5))),
    generate: (request) => {
      const prompt = request.messages.map((message) => message.content).join('\n');
      const handles = [...new Set(prompt.match(/\[S\d+\]/g) ?? [])].map((tag) => tag.slice(1, -1));
      return Promise.resolve({
        sentences: [
          { text: 'The session worked through the Ariadne rollout.', source_ids: handles },
        ],
      });
    },
  };
}

async function seedSession(sessionId: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: sessionId,
    now: new Date(EPISODES[0]!.at),
  });
}

async function seedEpisode(episode: { id: string; at: string }, sessionId: string): Promise<void> {
  const at = new Date(episode.at);
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: episode.id,
    now: at,
    occurredAt: at,
    properties: {
      [MEMORY_PROPERTIES.text]: `The pair moved the Ariadne rollout along in ${episode.id}.`,
      [MEMORY_PROPERTIES.sessionId]: sessionId,
    },
  });
  await upsertEdge(harness.driver, {
    type: CONTAINMENT_TYPE,
    sourceId: episode.id,
    targetId: sessionId,
    strength: 1,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test'],
    count: 0,
    now: at,
  });
}

function stageContext(sessionId: string, episodeId: string, now: Date): StageContext {
  return {
    driver: harness.driver,
    db,
    provider: stubProvider(),
    episodeId,
    episode: { id: episodeId, sessionId, text: `body of ${episodeId}`, turns: [] },
    logger,
    now,
    occurredAt: now,
    pipelineVersion: PIPELINE_VERSION,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-mid-session-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  deps = { driver: harness.driver, provider: stubProvider(), logger };

  for (const sessionId of [SESSION_ID, QUIET_SESSION_ID]) {
    await seedSession(sessionId);
    for (const episode of EPISODES) {
      await seedEpisode({ ...episode, id: `${sessionId}-${episode.id}` }, sessionId);
    }
  }
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the mid-session boundary against a live substrate', () => {
  let midSessionNarrativeId: string;

  it('waits for the close while the boundary is switched off', async () => {
    const outcome = await new SessionNarrativeStage({ midSession: false }).run(
      stageContext(QUIET_SESSION_ID, `${QUIET_SESSION_ID}-mid-e3`, MID_SESSION_NOW),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toBe('the session is still active');
    expect(await findSessionNarratives(harness.driver, QUIET_SESSION_ID)).toEqual([]);
  });

  it('compresses a running session that has paused, before any close', async () => {
    const outcome = await new SessionNarrativeStage().run(
      stageContext(SESSION_ID, `${SESSION_ID}-mid-e3`, MID_SESSION_NOW),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ narratives: 1 });

    const versions = await findSessionNarratives(harness.driver, SESSION_ID);
    expect(
      versions.map((version) => [version.version, version.open, version.coverageCount]),
    ).toEqual([[1, true, 3]]);
    midSessionNarrativeId = versions[0]!.id;

    const properties = await nodeProperties(harness.driver, midSessionNarrativeId);
    expect(properties[NARRATIVE_PROPERTIES.scope]).toBe('session');
    expect((properties[NARRATIVE_PROPERTIES.citations] as string[]).length).toBeGreaterThan(0);
  });

  it('leaves the boundary alone while the session adds nothing and does not pause again', async () => {
    const outcome = await new SessionNarrativeStage().run(
      stageContext(SESSION_ID, `${SESSION_ID}-mid-e3`, MID_SESSION_NOW),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toBe(
      'the session is still active: the standing narrative covers every episode',
    );
  });

  it('supersedes the mid-session version into the one the close writes', async () => {
    for (const episode of LATE_EPISODES) {
      await seedEpisode({ ...episode, id: `${SESSION_ID}-${episode.id}` }, SESSION_ID);
    }

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: CLOSE_NOW });

    expect(result.status).toBe('created');
    expect(result.version).toBe(2);

    const versions = await findSessionNarratives(harness.driver, SESSION_ID);
    expect(
      versions.map((version) => [version.version, version.open, version.coverageCount]),
    ).toEqual([
      [2, true, 5],
      [1, false, 3],
    ]);

    expect(await edgeTargetId(harness.driver, 'SUPERSEDES', result.narrativeId!)).toBe(
      midSessionNarrativeId,
    );
    const closed = await nodeProperties(harness.driver, midSessionNarrativeId);
    expect(closed[BITEMPORAL_PROPERTIES.validUntil]).toBeInstanceOf(Date);
  });
});
