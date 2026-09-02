import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, writeStampedNode } from './bitemporal.js';
import { CLAIM_ASPECT_PROPERTY, CLAIM_SUBJECT_PROPERTY } from './claim-key-queries.js';
import { readFirst } from './connection.js';
import { closeEligibleAssociationEdges } from './edge-prune-queries.js';
import { upsertEdge } from './edges.js';
import { MAX_STORED_ENTITY_ALIASES } from './entity-identity-queries.js';
import { redirectAndAbsorb } from './entity-merge-queries.js';
import { runGraphMigrations } from './migrations.js';
import {
  countEdges,
  nodeProperties,
  supersedingNodeIds,
} from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { applyUnmerge, readCanonicalMerge, type MergeProvenanceRecord } from './unmerge-queries.js';
import { foldName } from '../../reflection/domain/name-fold.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The merge write path against a real server. Each case here is a claim about what
 * `redirectAndAbsorb` does inside its own transaction under a live lock manager, where a
 * concurrent writer can take a member's currency between the decision and the write. The
 * fake graph cannot lose these races, so it cannot prove any of this.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-01T00:05:00.000Z');
/** Old enough that the prune sweep's unreinforced window has elapsed by `NOW`. */
const LONG_AGO = new Date('2026-07-01T00:00:00.000Z');
const ASSOCIATION_FLOOR = 0.05;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEntity(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    properties: { name: id, name_norm: id, type: 'concept' },
    now: NOW,
  });
}

/** Open edges only, which is the population recall traverses and the merge may add to. */
async function openEdgeCount(type: string, aId: string, bId: string): Promise<number> {
  const count = await readFirst(
    harness.driver,
    [
      `MATCH ({ id: $aId })-[r:${type}]-({ id: $bId })`,
      `WHERE r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
      'RETURN count(r) AS c',
    ].join('\n'),
    { aId, bId },
    (row) => row.c as number,
  );
  return count ?? 0;
}

type ProvenanceEdgeRecord = {
  readonly type: string;
  readonly other_id: string;
  readonly redirected: boolean;
};

type ProvenanceRecord = {
  readonly merged_id: string;
  readonly edges?: ProvenanceEdgeRecord[];
  readonly claims?: string[];
};

function provenanceRecords(records: unknown, mergedId: string): ProvenanceRecord[] {
  return ((records ?? []) as string[])
    .map((record) => JSON.parse(record) as ProvenanceRecord)
    .filter((record) => record.merged_id === mergedId);
}

/** The edge trail one absorbed identity contributed, as the unmerge operation reads it back. */
function provenanceEdges(records: unknown, mergedId: string): ProvenanceEdgeRecord[] {
  return provenanceRecords(records, mergedId).flatMap((record) => record.edges ?? []);
}

/** The claims whose subject key the merge moved, which is what an unmerge hands back. */
function provenanceClaims(records: unknown, mergedId: string): string[] {
  return provenanceRecords(records, mergedId).flatMap((record) => record.claims ?? []);
}

function storedAliases(properties: Record<string, unknown>): string[] {
  return (properties.aliases ?? []) as string[];
}

function storedAliasKeys(properties: Record<string, unknown>): string[] {
  return (properties.aliases_norm ?? []) as string[];
}

/** The trail entry an unmerge is driven from, which the merge must have written for it to exist. */
async function absorbedRecord(mergedId: string): Promise<MergeProvenanceRecord> {
  const canonical = await readCanonicalMerge(harness.driver, mergedId);
  const record = canonical?.records.find((entry) => entry.mergedId === mergedId);
  if (record === undefined) {
    throw new Error(`no merge record names ${mergedId}`);
  }
  return record;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-merge-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a merge deciding from a stale snapshot', () => {
  it('refuses the whole group when another merge already absorbed a member', async () => {
    for (const id of ['stale-canon', 'stale-dup', 'stale-rival', 'stale-neighbor']) {
      await seedEntity(id);
    }
    await upsertEdge(harness.driver, {
      type: 'CO_OCCURS',
      sourceId: 'stale-dup',
      targetId: 'stale-neighbor',
      strength: 0.5,
      confidence: 1,
      signals: ['episodic'],
      provenance: ['test'],
      count: 1,
      now: NOW,
    });

    // The rival lands first: stale-dup loses currency to stale-rival.
    await redirectAndAbsorb(harness.driver, {
      canonicalId: 'stale-rival',
      canonicalNameNorm: 'stale-rival',
      mergedIds: ['stale-dup'],
      aliases: ['stale-dup'],
      accessCount: 0,
      now: NOW,
    });

    // This merge decided on a snapshot taken before the rival committed.
    const result = await redirectAndAbsorb(harness.driver, {
      canonicalId: 'stale-canon',
      canonicalNameNorm: 'stale-canon',
      mergedIds: ['stale-dup'],
      aliases: ['stale-dup'],
      accessCount: 3,
      now: LATER,
    });

    // Nothing of the stale group's write lands: no redirected edge, no provenance record,
    // and the absorbed identity answers to its real canonical alone.
    expect(await countEdges(harness.driver, 'CO_OCCURS', 'stale-canon', 'stale-neighbor')).toBe(0);
    const props = await nodeProperties(harness.driver, 'stale-canon');
    expect(props.merge_provenance ?? []).toEqual([]);
    expect(await supersedingNodeIds(harness.driver, 'stale-dup')).toEqual(['stale-rival']);
    expect(result.status).toBe('stale');
  });
});

describe('a merge over an absorbed node whose association edge_prune closed', () => {
  it('records the closed edge without reopening it on the canonical', async () => {
    for (const id of ['pruned-canon', 'pruned-dup', 'pruned-neighbor']) {
      await seedEntity(id);
    }
    await upsertEdge(harness.driver, {
      type: 'CO_OCCURS',
      sourceId: 'pruned-dup',
      targetId: 'pruned-neighbor',
      strength: ASSOCIATION_FLOOR,
      confidence: 1,
      signals: ['episodic'],
      provenance: ['test'],
      count: 1,
      now: LONG_AGO,
    });

    // The real close path, not a hand-written SET: what the merge must respect is exactly
    // what the prune sweep writes.
    const closed = await closeEligibleAssociationEdges(harness.driver, {
      batchSize: 10,
      weightFloor: ASSOCIATION_FLOOR,
      unreinforcedDays: 30,
      now: NOW,
    });
    expect(closed.map((edge) => edge.targetId)).toEqual(['pruned-neighbor']);

    await redirectAndAbsorb(harness.driver, {
      canonicalId: 'pruned-canon',
      canonicalNameNorm: 'pruned-canon',
      mergedIds: ['pruned-dup'],
      aliases: ['pruned-dup'],
      accessCount: 0,
      mergedRecords: [
        {
          id: 'pruned-dup',
          name: 'pruned-dup',
          nameNorm: 'pruned-dup',
          type: 'concept',
          aliases: [],
        },
      ],
      now: LATER,
    });

    // A closed edge moves as a record, never as a write: the canonical gains no live
    // association, and the unmerge trail still states what the absorbed identity held.
    expect(await openEdgeCount('CO_OCCURS', 'pruned-canon', 'pruned-neighbor')).toBe(0);
    const props = await nodeProperties(harness.driver, 'pruned-canon');
    expect(provenanceEdges(props.merge_provenance, 'pruned-dup')).toEqual([
      expect.objectContaining({
        type: 'CO_OCCURS',
        other_id: 'pruned-neighbor',
        redirected: false,
      }),
    ]);
  });
});

describe('a merge pushing an identity past the stored alias cap', () => {
  it('leaves every stored spelling with the key that routes it, through the merge and back', async () => {
    for (const id of ['alias-canon', 'alias-filler', 'alias-dup']) {
      await seedEntity(id);
    }

    // A full alias list first, so the second merge has to cut. `Zulu spelling` sorts ahead of
    // every `spelling NN` as a surface form and behind every one of them as a lookup key.
    const stored = Array.from(
      { length: MAX_STORED_ENTITY_ALIASES },
      (_, index) => `spelling ${String(index).padStart(2, '0')}`,
    );
    await redirectAndAbsorb(harness.driver, {
      canonicalId: 'alias-canon',
      canonicalNameNorm: 'alias-canon',
      mergedIds: ['alias-filler'],
      aliases: stored,
      accessCount: 0,
      now: NOW,
    });

    await redirectAndAbsorb(harness.driver, {
      canonicalId: 'alias-canon',
      canonicalNameNorm: 'alias-canon',
      mergedIds: ['alias-dup'],
      aliases: ['Zulu spelling', 'zulu spelling'],
      accessCount: 0,
      mergedRecords: [
        {
          id: 'alias-dup',
          name: 'alias-dup',
          nameNorm: 'alias-dup',
          type: 'concept',
          aliases: ['Zulu spelling', 'zulu spelling'],
        },
      ],
      now: NOW,
    });

    const canonical = await nodeProperties(harness.driver, 'alias-canon');
    expect(storedAliases(canonical).map((alias) => foldName(alias))).toEqual(
      storedAliasKeys(canonical),
    );

    const split = await applyUnmerge(harness.driver, {
      canonicalId: 'alias-canon',
      record: await absorbedRecord('alias-dup'),
      now: LATER,
    });

    const restored = await nodeProperties(harness.driver, split.restoredId);
    expect(storedAliases(restored).map((alias) => foldName(alias))).toEqual(
      storedAliasKeys(restored),
    );
  });
});

describe('a merge over the entity a claim names as its subject', () => {
  it('forwards the claim key onto the canonical and hands it back on an unmerge', async () => {
    for (const id of ['subject-canon', 'subject-dup']) {
      await seedEntity(id);
    }
    await writeStampedNode(harness.driver, {
      label: 'Insight',
      id: 'subject-claim',
      properties: {
        text: 'the retry ceiling is eight',
        [CLAIM_SUBJECT_PROPERTY]: 'subject-dup',
        [CLAIM_ASPECT_PROPERTY]: 'retry ceiling',
      },
      occurredAt: NOW,
      now: NOW,
    });

    await redirectAndAbsorb(harness.driver, {
      canonicalId: 'subject-canon',
      canonicalNameNorm: 'subject-canon',
      mergedIds: ['subject-dup'],
      aliases: ['subject-dup'],
      accessCount: 0,
      mergedRecords: [
        {
          id: 'subject-dup',
          name: 'subject-dup',
          nameNorm: 'subject-dup',
          type: 'concept',
          aliases: [],
        },
      ],
      now: NOW,
    });

    // The key follows the identity, so the claim still keys on an entity the graph answers for.
    const merged = await nodeProperties(harness.driver, 'subject-claim');
    expect(merged[CLAIM_SUBJECT_PROPERTY]).toBe('subject-canon');

    const canonical = await nodeProperties(harness.driver, 'subject-canon');
    expect(provenanceClaims(canonical.merge_provenance, 'subject-dup')).toEqual(['subject-claim']);

    const split = await applyUnmerge(harness.driver, {
      canonicalId: 'subject-canon',
      record: await absorbedRecord('subject-dup'),
      now: LATER,
    });

    // The split identity is the node the restored edges land on, so the key lands there too.
    const unmerged = await nodeProperties(harness.driver, 'subject-claim');
    expect(unmerged[CLAIM_SUBJECT_PROPERTY]).toBe(split.restoredId);
  });
});
