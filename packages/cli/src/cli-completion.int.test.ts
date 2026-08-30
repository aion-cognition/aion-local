import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapBackbone,
  openSqliteHandle,
  recordPackMethodCounts,
  recordRecallOutcome,
  recordSupersessionProposal,
  runGraphMigrations,
  supersede,
  upsertEdge,
  writeStampedNode,
  type SqliteHandle,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runForget } from './forget.js';
import { runSearch } from './search.js';
import { runStats } from './stats.js';
import { runWhy } from './why.js';

/**
 * `stats`, `why`, `search`, and `forget` against a substrate seeded directly through the
 * graph write primitives, not through reflection: what these commands read is graph shape
 * and SQLite counters, and seeding that way keeps the file deterministic and fast rather
 * than depending on what a model extracts.
 */

const EMBED_DIMENSION = 768;
const AION_OLLAMA_URL = process.env['AION_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
const ENV_KEYS = [
  'AION_NEO4J_URI',
  'AION_NEO4J_PASSWORD',
  'AION_SQLITE_PATH',
  'AION_OLLAMA_URL',
  'AION_EMBED_DIMENSION',
  'AION_LOG_FILE',
  'AION_LOG_LEVEL',
] as const;

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

let harness: Neo4jHarness;
let dir: string;
let db: SqliteHandle;
let episodeId: string;

async function writeDecision(id: string, text: string, occurredAt: Date): Promise<string> {
  const node = await writeStampedNode(harness.driver, {
    label: 'Decision',
    id,
    properties: { text, source_episode_id: episodeId, extraction_method: 'cognitive-extraction' },
    occurredAt,
    now: occurredAt,
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: node.id,
    targetId: episodeId,
    strength: 1,
    confidence: 1,
    signals: ['reflection'],
    provenance: ['cognitive-extraction'],
    count: 0,
    now: occurredAt,
  });
  return node.id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dir = mkdtempSync(join(tmpdir(), 'aion-cli-completion-int-'));
  const sqlitePath = join(dir, 'aion.sqlite');
  db = openSqliteHandle({ filePath: sqlitePath });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  await bootstrapBackbone(harness.driver, { memberName: 'CLI Completion Test' });

  process.env['AION_NEO4J_URI'] = harness.uri;
  process.env['AION_NEO4J_PASSWORD'] = harness.password;
  process.env['AION_SQLITE_PATH'] = sqlitePath;
  process.env['AION_OLLAMA_URL'] = AION_OLLAMA_URL;
  process.env['AION_EMBED_DIMENSION'] = String(EMBED_DIMENSION);
  process.env['AION_LOG_FILE'] = join(dir, 'aion.jsonl');
  process.env['AION_LOG_LEVEL'] = 'fatal';

  episodeId = (
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      properties: { summary: 'a planning conversation about the sync engine' },
    })
  ).id;
}, 180_000);

afterAll(async () => {
  db.close();
  await stopNeo4jHarness(harness);
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe('aion stats against a seeded substrate', () => {
  it('shows moving numbers for cadence and per-method pack counters', async () => {
    recordRecallOutcome(db, { empty: false });
    recordPackMethodCounts(db, ['vector', 'vector', 'bm25']);

    const { lines, write } = collector();
    expect(await runStats([], write)).toBe(0);
    const text = lines.join('\n');

    expect(text).toContain('Episode');
    expect(text).toContain('calls        1 across 0 sessions');
    expect(text).toMatch(/vector\s+2\s+66\.7%/);
    expect(text).toMatch(/bm25\s+1\s+33\.3%/);
  });
});

describe('aion why against a seeded substrate', () => {
  let oldId: string;
  let newId: string;

  beforeAll(async () => {
    oldId = randomUUID();
    newId = randomUUID();
    await writeDecision(oldId, 'we picked polling for the sync engine', new Date('2026-06-01T00:00:00.000Z'));
    await writeDecision(newId, 'we picked webhooks for the sync engine', new Date('2026-06-05T00:00:00.000Z'));
    await supersede(harness.driver, { oldId, newId, now: new Date('2026-06-05T00:00:00.000Z') });
    recordSupersessionProposal(db, {
      oldId,
      newId,
      confidence: 0.97,
      rationale: 'restated with the corrected vendor',
      episodeId,
    });
  });

  it('shows a current node with its extraction provenance and what it supersedes', async () => {
    const { lines, write } = collector();

    expect(await runWhy([newId], write)).toBe(0);

    const text = lines.join('\n');
    expect(text).toContain('currency  current');
    expect(text).toContain(`extracted from     ${episodeId}`);
    expect(text).toContain(`supersedes  ${oldId}`);
  });

  it('shows the full lineage on the superseded node, honestly, plus the open proposal', async () => {
    const { lines, write } = collector();

    expect(await runWhy([oldId], write)).toBe(0);

    const text = lines.join('\n');
    expect(text).toContain('currency  superseded');
    expect(text).toContain(`superseded by ${newId}`);
    expect(text).toContain(`superseded by  ${newId}`);
    expect(text).toContain(`supersession`);
    expect(text).toContain('confidence 0.97');
  });
});

describe('aion search against a seeded substrate', () => {
  const QUERY = 'sync engine ingestion approach';
  let beforeId: string;
  let afterId: string;
  const supersessionAt = new Date('2026-07-05T00:00:00.000Z');

  beforeAll(async () => {
    beforeId = randomUUID();
    afterId = randomUUID();
    await writeDecision(
      beforeId,
      'the sync engine started on a nightly batch job',
      new Date('2026-07-01T00:00:00.000Z'),
    );
    await writeDecision(
      afterId,
      'the sync engine moved to change-data-capture streaming',
      supersessionAt,
    );
    await supersede(harness.driver, { oldId: beforeId, newId: afterId, now: supersessionAt });
  });

  it('honors --as-of: the pre-supersession world sees the old node, not the new one', async () => {
    const { lines, write } = collector();

    expect(
      await runSearch([QUERY, '--as-of', '2026-07-02T00:00:00.000Z', '--json'], write),
    ).toBe(0);

    const results = JSON.parse(lines.join('')) as Array<{ id: string }>;
    const ids = results.map((row) => row.id);
    expect(ids).toContain(beforeId);
    expect(ids).not.toContain(afterId);
  });

  it('honors --as-of after the supersession: the new node, not the closed one', async () => {
    const { lines, write } = collector();

    expect(
      await runSearch([QUERY, '--as-of', '2026-07-10T00:00:00.000Z', '--json'], write),
    ).toBe(0);

    const results = JSON.parse(lines.join('')) as Array<{ id: string }>;
    const ids = results.map((row) => row.id);
    expect(ids).toContain(afterId);
    expect(ids).not.toContain(beforeId);
  });
});

describe('aion forget against a seeded substrate', () => {
  const QUERY = 'quarterly budget review notes for forgetting';
  let id: string;
  let beforeForget: string;

  beforeAll(async () => {
    id = randomUUID();
    beforeForget = new Date().toISOString();
    await writeDecision(id, 'quarterly budget review notes for forgetting', new Date());
  });

  it('closes the node with --yes and default search stops surfacing it', async () => {
    const forgetResult = collector();
    expect(await runForget([id, '--yes'], forgetResult.write)).toBe(0);
    expect(forgetResult.lines.join('\n')).toContain(`forgot ${id}`);

    const { lines, write } = collector();
    expect(await runSearch([QUERY, '--json'], write)).toBe(0);
    const results = JSON.parse(lines.join('')) as Array<{ id: string }>;
    expect(results.map((row) => row.id)).not.toContain(id);
  });

  it('a --knew-at read from before the forget still finds it', async () => {
    const { lines, write } = collector();

    expect(await runSearch([QUERY, '--knew-at', beforeForget, '--json'], write)).toBe(0);

    const results = JSON.parse(lines.join('')) as Array<{ id: string }>;
    expect(results.map((row) => row.id)).toContain(id);
  });
});
