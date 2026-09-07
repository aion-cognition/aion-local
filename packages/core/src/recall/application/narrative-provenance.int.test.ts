import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { fetchClaimProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { closeNarrativeEdgesInTransaction } from '../../infrastructure/graph/narrative-edge-queries.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { knewAt, withCurrency, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { RelationshipType } from '../../infrastructure/graph/relationships.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { assemble, item } from '../domain/test-support/pack.fixture.js';

/**
 * Where a narrative came from, read the same bounded, mode-aware way every other memory's lineage
 * is read. A narrative names no capture and hangs off no extraction edge, so the stored citations
 * are the whole of its evidence ancestry. Its `DERIVES_FROM` edge points at the session that
 * produced it, which says where it lives rather than what it is drawn from.
 */

const EMBED_DIMENSION = 8;

const SEEDED_AT = new Date('2026-06-01T09:00:00.000Z');
const LATE = new Date('2026-06-05T09:00:00.000Z');
const BEFORE_LATE = new Date('2026-06-03T09:00:00.000Z');

const ROOT_ID = 'narrative-prov-root';
const CLAIM_ID = 'narrative-prov-claim';
const DIRECT_ID = 'narrative-prov-direct';
const VIA_CLAIM_ID = 'narrative-prov-via-claim';
const MEMBER_ID = 'narrative-prov-member';
const ROLLUP_ID = 'narrative-prov-rollup';
const ECHO_ID = 'narrative-prov-echo';
const SESSION_ID = 'narrative-prov-session';
const CONTAINED_ID = 'narrative-prov-contained';
const UNCITED_ID = 'narrative-prov-uncited';
const UNRESOLVED_ID = 'narrative-prov-unresolved';
const CYCLE_A_ID = 'narrative-prov-cycle-a';
const CYCLE_B_ID = 'narrative-prov-cycle-b';
const WIDE_ID = 'narrative-prov-wide';
const LATE_SOURCE_ID = 'narrative-prov-late-source';
const EARLY_ID = 'narrative-prov-early';
const CLOSED_ID = 'narrative-prov-closed';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function writeEpisode(id: string, now: Date = SEEDED_AT): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now,
    occurredAt: now,
    properties: { text: `capture ${id}`, session_id: `${id}-session` },
  });
}

async function writeNarrative(
  id: string,
  citations: readonly string[] | undefined,
  now: Date = SEEDED_AT,
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Narrative',
    id,
    now,
    occurredAt: now,
    properties: {
      text: `an account under ${id}`,
      summary: `summary of ${id}`,
      ...(citations === undefined ? {} : { [NARRATIVE_PROPERTIES.citations]: [...citations] }),
    },
  });
}

async function link(type: RelationshipType, sourceId: string, targetId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type,
    sourceId,
    targetId,
    strength: 1,
    confidence: 1,
    signals: ['compression'],
    provenance: ['test-fixture'],
    count: 0,
    now: SEEDED_AT,
  });
}

async function provenanceOf(ids: readonly string[], maxRoots = 4, mode: ReadMode = withCurrency()) {
  return fetchClaimProvenance(harness.driver, { ids, maxRoots, mode });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-narrative-provenance-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeEpisode(ROOT_ID);
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id: CLAIM_ID,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: { text: 'the queue design uses a worker' },
  });
  await link('EXTRACTED_FROM', CLAIM_ID, ROOT_ID);

  await writeNarrative(DIRECT_ID, [ROOT_ID]);
  await link(SUMMARIZED_BY_TYPE, ROOT_ID, DIRECT_ID);

  await writeNarrative(VIA_CLAIM_ID, [CLAIM_ID]);

  await writeNarrative(MEMBER_ID, [ROOT_ID]);
  await writeNarrative(ROLLUP_ID, [MEMBER_ID]);

  await writeEpisode(ECHO_ID);
  await link(DERIVES_FROM_TYPE, ECHO_ID, DIRECT_ID);

  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: SESSION_ID,
    now: SEEDED_AT,
    occurredAt: SEEDED_AT,
    properties: { text: 'a session' },
  });
  await writeNarrative(CONTAINED_ID, [ROOT_ID]);
  await link(DERIVES_FROM_TYPE, CONTAINED_ID, SESSION_ID);
  await writeNarrative(UNCITED_ID, undefined);
  await link(DERIVES_FROM_TYPE, UNCITED_ID, SESSION_ID);

  await writeNarrative(UNRESOLVED_ID, ['narrative-prov-nothing-holds-this']);

  await writeNarrative(CYCLE_A_ID, [CYCLE_B_ID]);
  await writeNarrative(CYCLE_B_ID, [CYCLE_A_ID]);

  await writeEpisode('narrative-prov-wide-a');
  await writeEpisode('narrative-prov-wide-b');
  await writeEpisode('narrative-prov-wide-c');
  await writeNarrative(WIDE_ID, [
    'narrative-prov-wide-a',
    'narrative-prov-wide-b',
    'narrative-prov-wide-c',
  ]);

  await writeNarrative(EARLY_ID, [LATE_SOURCE_ID]);
  await writeEpisode(LATE_SOURCE_ID, LATE);

  await writeNarrative(CLOSED_ID, [ROOT_ID]);
  await link(SUMMARIZED_BY_TYPE, ROOT_ID, CLOSED_ID);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the sources a narrative cites', () => {
  it('resolves the episode its stored sentences named', async () => {
    const rows = await provenanceOf([DIRECT_ID]);

    expect(rows.get(DIRECT_ID)).toMatchObject({ roots: [ROOT_ID], complete: true });
  });

  it('follows a cited claim through to the capture it was extracted from', async () => {
    const rows = await provenanceOf([VIA_CLAIM_ID]);

    expect(rows.get(VIA_CLAIM_ID)).toMatchObject({ roots: [ROOT_ID], complete: true });
  });

  it('follows a rollup through the narratives it cites to their own sources', async () => {
    const rows = await provenanceOf([ROLLUP_ID]);

    expect(rows.get(ROLLUP_ID)).toMatchObject({ roots: [ROOT_ID], complete: true });
  });

  it('follows a stated derivation that names a narrative', async () => {
    const rows = await provenanceOf([ECHO_ID]);

    expect(rows.get(ECHO_ID)).toMatchObject({ roots: [ROOT_ID], complete: true });
  });

  /**
   * The session a narrative was written in says where it lives. Reading it as evidence would
   * make every narrative of a session one witness with every other, and with none of them.
   */
  it('reads the session it derives from as a container rather than a source', async () => {
    const rows = await provenanceOf([CONTAINED_ID]);

    expect(rows.get(CONTAINED_ID)?.roots).toEqual([ROOT_ID]);
    expect(rows.get(CONTAINED_ID)?.roots).not.toContain(SESSION_ID);
  });

  it('keeps the citation after the summarization edges have closed', async () => {
    await supersede(harness.driver, { oldId: CLOSED_ID, newId: DIRECT_ID, now: LATE });
    await inWriteTransaction(harness.driver, async (tx) => {
      await closeNarrativeEdgesInTransaction(tx, {
        narrativeIds: [CLOSED_ID],
        validUntil: LATE,
        txUntil: LATE,
      });
    });

    const rows = await provenanceOf([CLOSED_ID]);

    expect(rows.get(CLOSED_ID)).toMatchObject({ roots: [ROOT_ID], complete: true });
  });
});

describe('a narrative whose sources the substrate cannot answer for', () => {
  it('reports a narrative that cites nothing as short rather than as its own source', async () => {
    const record = (await provenanceOf([UNCITED_ID])).get(UNCITED_ID);

    expect(record?.complete).toBe(false);
    expect(record?.roots).toEqual([UNCITED_ID]);
    expect(record?.roots).not.toContain(SESSION_ID);
  });

  it('reports a citation the substrate does not hold as short', async () => {
    const record = (await provenanceOf([UNRESOLVED_ID])).get(UNRESOLVED_ID);

    expect(record?.complete).toBe(false);
    expect(record?.roots).toEqual([UNRESOLVED_ID]);
  });

  it('stops a citation cycle instead of walking it', async () => {
    const record = (await provenanceOf([CYCLE_A_ID])).get(CYCLE_A_ID);

    expect(record?.complete).toBe(false);
  });

  it('reports a wider citation set short rather than growing past the caller bound', async () => {
    const record = (await provenanceOf([WIDE_ID], 2)).get(WIDE_ID);

    expect(record?.roots).toHaveLength(2);
    expect(record?.complete).toBe(false);
  });

  /**
   * A source written after the pinned moment is not lineage the substrate held then, so the walk
   * reports the narrative short rather than naming a root nobody could read.
   */
  it('leaves a source written after the pinned moment out of the answer', async () => {
    const pinned = (await provenanceOf([EARLY_ID], 4, knewAt(BEFORE_LATE))).get(EARLY_ID);

    expect(pinned?.roots).toEqual([EARLY_ID]);
    expect(pinned?.complete).toBe(false);

    const present = (await provenanceOf([EARLY_ID])).get(EARLY_ID);
    expect(present).toMatchObject({ roots: [LATE_SOURCE_ID], complete: true });
  });
});

describe('a narrative and a claim drawn from one capture', () => {
  it('renders them as one witness rather than as two', async () => {
    const provenance = await provenanceOf([DIRECT_ID, CLAIM_ID]);

    expect(provenance.get(DIRECT_ID)?.roots).toEqual([ROOT_ID]);
    expect(provenance.get(CLAIM_ID)?.roots).toEqual([ROOT_ID]);

    const pack = assemble(
      [
        item(CLAIM_ID, { labels: ['Insight', 'Memory', 'AionNode'] }),
        item(DIRECT_ID, { labels: ['Narrative', 'Memory', 'AionNode'] }),
      ],
      { provenance },
    );

    expect(pack.narratives?.[0]?.derivation?.shared_with).toEqual([CLAIM_ID]);
    expect(pack.rendered_text).toContain('not independent corroboration');
  });
});
