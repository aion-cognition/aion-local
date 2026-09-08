import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, writeStampedNode } from './bitemporal.js';
import {
  readEntityMentionDistribution,
  readGraphSourcePage,
  readNarrativeEdgeStatePage,
  readNarrativePage,
  readRelationshipTypeCounts,
  type NarrativeEdgeState,
} from './campaign-cohort-queries.js';
import { runWrite } from './connection.js';
import { upsertEdge } from './edges.js';
import { ENTITY_MENTION_TYPE } from './entity-mention-queries.js';
import { runGraphMigrations } from './migrations.js';
import { SUMMARIZED_BY_TYPE } from './narrative-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime } from './values.js';
import {
  advanceProgress,
  boundPage,
  EMPTY_PROGRESS,
  exportIsComplete,
  type ExportProgress,
  type PageShape,
} from '../../introspection/domain/campaign-paging.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The cohort walk against a real server. Its subject is a bitemporal predicate over a
 * relationship and a keyset page over relationship ids, neither of which a fake driver
 * carries.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const CLOSED_AT = new Date('2026-09-01T10:00:00.000Z');

/** Three narratives, one of them superseded, and four summarization edges into them. */
const OPEN_NARRATIVE = 'campaign-narrative-open';
const CLOSED_NARRATIVE = 'campaign-narrative-closed';
const STALE_EDGE_IDS = ['edge-0001', 'edge-0002', 'edge-0003'];
const ACTIVE_EDGE_ID = 'edge-0004';

const SHAPE: PageShape<NarrativeEdgeState> = { key: (row) => row.id, bytes: () => 64 };

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string, sessionId: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: `episode ${id}`, session_id: sessionId },
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-campaign-cohort-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  for (const narrative of [OPEN_NARRATIVE, CLOSED_NARRATIVE]) {
    await writeStampedNode(harness.driver, {
      label: 'Narrative',
      id: narrative,
      now: NOW,
      properties: { text: `narrative ${narrative}` },
    });
  }

  for (const [index, edgeId] of [...STALE_EDGE_IDS, ACTIVE_EDGE_ID].entries()) {
    const episodeId = `campaign-episode-${String(index)}`;
    await seedEpisode(episodeId, `campaign-session-${String(index % 2)}`);
    await upsertEdge(harness.driver, {
      type: SUMMARIZED_BY_TYPE,
      id: edgeId,
      sourceId: episodeId,
      targetId: edgeId === ACTIVE_EDGE_ID ? OPEN_NARRATIVE : CLOSED_NARRATIVE,
      strength: 1,
      confidence: 1,
      signals: ['test'],
      provenance: ['test'],
      now: NOW,
    });
  }

  for (const [index, name] of ['mentioned', 'unmentioned'].entries()) {
    await writeStampedNode(harness.driver, {
      label: 'Entity',
      id: `campaign-entity-${String(index)}`,
      now: NOW,
      properties: { name, name_norm: name, entity_type: 'concept' },
    });
  }
  await upsertEdge(harness.driver, {
    type: ENTITY_MENTION_TYPE,
    sourceId: 'campaign-episode-0',
    targetId: 'campaign-entity-0',
    strength: 1,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test'],
    now: NOW,
  });

  // What a supersession writes: the narrative stops standing while the edges into it stay open.
  await runWrite(
    harness.driver,
    [
      'MATCH (n:Narrative { id: $id })',
      `SET n.${BITEMPORAL_PROPERTIES.validUntil} = $now`,
      'RETURN n.id AS id',
    ].join('\n'),
    { id: CLOSED_NARRATIVE, now: toGraphDateTime(CLOSED_AT) },
    (row) => row.id as string,
  );
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('walking the summarization edges', () => {
  it('reports each edge with its own state and its target narrative state', async () => {
    const page = await readNarrativeEdgeStatePage(harness.driver, 100);
    const byId = new Map(page.map((edge) => [edge.id, edge]));

    expect(byId.get('edge-0001')).toMatchObject({ open: true, targetClosed: true });
    expect(byId.get(ACTIVE_EDGE_ID)).toMatchObject({ open: true, targetClosed: false });
  });

  it('keeps a closed edge in the walk so a repair is not read as a removal', async () => {
    await runWrite(
      harness.driver,
      [
        `MATCH ()-[r:${SUMMARIZED_BY_TYPE}]->()`,
        'WHERE r.id = $id',
        `SET r.${BITEMPORAL_PROPERTIES.validUntil} = $now`,
        'RETURN r.id AS id',
      ].join('\n'),
      { id: 'edge-0003', now: toGraphDateTime(CLOSED_AT) },
      (row) => row.id as string,
    );

    const page = await readNarrativeEdgeStatePage(harness.driver, 100);
    expect(page.find((edge) => edge.id === 'edge-0003')).toMatchObject({
      open: false,
      targetClosed: true,
    });
  });

  it('visits every edge exactly once across pages and resumes from the cursor', async () => {
    let progress: ExportProgress = EMPTY_PROGRESS;
    let cursor: string | undefined;

    for (let pass = 0; pass < 10; pass += 1) {
      const rows = await readNarrativeEdgeStatePage(harness.driver, 2, cursor);
      if (rows.length === 0) {
        break;
      }
      const page = boundPage(rows, SHAPE, { maxRows: 2, maxBytes: 4096 });
      progress = advanceProgress(progress, page, SHAPE);
      cursor = page.nextCursor ?? rows[rows.length - 1]?.id;
    }

    expect(exportIsComplete(progress, [...STALE_EDGE_IDS, ACTIVE_EDGE_ID])).toEqual({
      complete: true,
      missing: [],
      duplicated: [],
    });
  });

  it('changes nothing in the graph', async () => {
    const before = await readRelationshipTypeCounts(harness.driver);
    await readNarrativeEdgeStatePage(harness.driver, 100);
    await readGraphSourcePage(harness.driver, 100);
    await readEntityMentionDistribution(harness.driver, 100);
    expect(await readRelationshipTypeCounts(harness.driver)).toEqual(before);
  });
});

describe('the source page', () => {
  it('reports the episodes with their session, turn count and stored text size', async () => {
    const page = await readGraphSourcePage(harness.driver, 100);
    expect(page).toHaveLength(4);
    expect(page[0]).toMatchObject({
      id: 'campaign-episode-0',
      sessionId: 'campaign-session-0',
      turnCount: 0,
      enriched: false,
    });
    expect(page[0]?.textLength).toBeGreaterThan(0);
  });

  it('resumes after a cursor without repeating the row it stopped on', async () => {
    const first = await readGraphSourcePage(harness.driver, 2);
    const second = await readGraphSourcePage(harness.driver, 2, first[first.length - 1]?.id);
    expect(second.map((row) => row.id)).toEqual(['campaign-episode-2', 'campaign-episode-3']);
  });
});

describe('the relationship split', () => {
  it('counts closed edges beside open ones rather than dropping them', async () => {
    const counts = await readRelationshipTypeCounts(harness.driver);
    const summarized = counts.find((row) => row.type === SUMMARIZED_BY_TYPE);
    expect(summarized).toMatchObject({ open: 3, closed: 1 });
  });
});

describe('the mention distribution', () => {
  it('reports a zero-mention bucket rather than leaving those entities out', async () => {
    const buckets = await readEntityMentionDistribution(harness.driver, 1000);
    expect(buckets).toEqual([
      { mentions: 0, entities: 1 },
      { mentions: 1, entities: 1 },
    ]);
  });
});

describe('reaching one member by its own key', () => {
  it('answers with the edge the key names, whatever the cursor would have skipped', async () => {
    const page = await readNarrativeEdgeStatePage(harness.driver, 1, undefined, 'edge-0002');
    expect(page.map((edge) => edge.id)).toEqual(['edge-0002']);
  });

  it('answers with the episode the key names', async () => {
    const page = await readGraphSourcePage(harness.driver, 1, undefined, 'campaign-episode-2');
    expect(page.map((row) => row.id)).toEqual(['campaign-episode-2']);
  });

  it('answers with the narrative the key names', async () => {
    const page = await readNarrativePage(harness.driver, 1, undefined, CLOSED_NARRATIVE);
    expect(page.map((row) => row.id)).toEqual([CLOSED_NARRATIVE]);
  });

  it('answers with nothing for a key the cohort does not hold', async () => {
    expect(await readNarrativePage(harness.driver, 1, undefined, 'no-such-narrative')).toEqual([]);
  });
});
