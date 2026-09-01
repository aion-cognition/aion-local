import {
  openSqliteHandle,
  runGraphMigrations,
  writeStampedNode,
  type SqliteHandle,
} from '@aion/core';
import { redirectAndAbsorb } from '@aion/core/infrastructure/graph/entity-merge-queries.js';
import {
  mergeEntities,
  type EntityMergeInput,
} from '@aion/core/infrastructure/graph/entity-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runUnmerge } from './unmerge.js';

/**
 * `apply` takes the absorbed node's own id, so the preview it shows before asking has to look
 * up the canonical through the graph. A fake graph cannot stand in for that lookup, so this
 * runs the guard against a real merge in a real database rather than mocking the read away.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');
const CANONICAL_EPISODE = 'episode-canonical';
const DUPLICATE_EPISODE = 'episode-duplicate';

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

function entityInput(name: string, nameNorm: string, episodeId: string): EntityMergeInput {
  return {
    name,
    nameNorm,
    type: 'tool',
    text: `${name} is a database`,
    sourceEpisodeId: episodeId,
    extractionMethod: 'test',
    confidence: 0.9,
    occurredAt: NOW,
  };
}

let harness: Neo4jHarness;
let dir: string;
let db: SqliteHandle;
let canonicalId: string;
let mergedId: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dir = mkdtempSync(join(tmpdir(), 'aion-cli-unmerge-'));
  const sqlitePath = join(dir, 'aion.sqlite');
  db = openSqliteHandle({ filePath: sqlitePath });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  process.env.AION_NEO4J_URI = harness.uri;
  process.env.AION_NEO4J_PASSWORD = harness.password;
  process.env.AION_SQLITE_PATH = sqlitePath;
  process.env.AION_OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  process.env.AION_EMBED_DIMENSION = String(EMBED_DIMENSION);
  process.env.AION_LOG_FILE = join(dir, 'aion.jsonl');
  process.env.AION_LOG_LEVEL = 'fatal';

  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: CANONICAL_EPISODE,
    now: NOW,
    properties: { text: 'canonical episode' },
  });
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: DUPLICATE_EPISODE,
    now: NOW,
    properties: { text: 'duplicate episode' },
  });

  const [canonical] = await mergeEntities(
    harness.driver,
    [entityInput('Postgres', 'postgres', CANONICAL_EPISODE)],
    NOW,
  );
  const [duplicate] = await mergeEntities(
    harness.driver,
    [entityInput('PostgreSQL', 'postgresql', DUPLICATE_EPISODE)],
    NOW,
  );
  if (canonical === undefined || duplicate === undefined) {
    throw new Error('failed to seed the pair to merge');
  }
  canonicalId = canonical.id;
  mergedId = duplicate.id;

  await redirectAndAbsorb(harness.driver, {
    canonicalId,
    canonicalNameNorm: 'postgres',
    mergedIds: [mergedId],
    aliases: ['PostgreSQL'],
    accessCount: 0,
    supersedeSignals: ['entity_merge'],
    supersedeProvenance: ['test'],
    mergedRecords: [
      { id: mergedId, name: 'PostgreSQL', nameNorm: 'postgresql', type: 'tool', aliases: [] },
    ],
    now: NOW,
  });
}, 300_000);

afterAll(async () => {
  db.close();
  await stopNeo4jHarness(harness);
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
});

describe('aion unmerge apply against a real merge', () => {
  it('shows what the canonical absorbed and refuses without --yes on a non-tty stdin', async () => {
    // vitest runs with no terminal attached, so this is the same stdin a piped or scripted
    // invocation sees; a real TTY is what the interactive prompt branch needs, and no test
    // here claims to exercise that branch.
    expect(process.stdin.isTTY).toBeFalsy();
    const { lines, write } = collector();

    expect(await runUnmerge(['apply', mergedId], write)).toBe(1);

    const text = lines.join('\n');
    expect(text).toContain(`${canonicalId} has absorbed 1 identity(ies)`);
    expect(text).toContain(mergedId);
    expect(text).toContain('cancelled');

    // Nothing was written: the record `ls` reads is still there, unsplit.
    const listing = collector();
    expect(await runUnmerge(['ls', canonicalId], listing.write)).toBe(0);
    expect(listing.lines.join('\n')).toContain(`${canonicalId} has absorbed 1 identity(ies)`);
  });

  it('splits the identity back out with --yes', async () => {
    const { lines, write } = collector();

    expect(await runUnmerge(['apply', mergedId, '--yes'], write)).toBe(0);

    const text = lines.join('\n');
    expect(text).toContain(`${mergedId}: applied`);
    expect(text).toContain('restored as');

    const listing = collector();
    expect(await runUnmerge(['ls', canonicalId], listing.write)).toBe(0);
    expect(listing.lines.join('\n')).toContain(
      'has no merge record with an identity left to split out',
    );
  });
});
