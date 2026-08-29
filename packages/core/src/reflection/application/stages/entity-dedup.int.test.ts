import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { redirectAndAbsorb } from '../../../infrastructure/graph/entity-dedup-queries.js';
import {
  findEpisodeEntities,
  linkEntityMentions,
  mergeEntities,
  writeEntityVectors,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { findPendingVectorNodes } from '../../../infrastructure/graph/pending-vectors.js';
import {
  mentionCounts,
  participatingEpisodeIds,
  storedEntity,
  supersedingNodeIds,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../../infrastructure/providers/ollama-provider.js';
import type { Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { listEntityMergeProposals } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { entityMergeLedgerKey } from '../../domain/entity-merge.js';
import type { StageContext } from '../../domain/stage.js';
import { EntityDedupStage } from './entity-dedup.js';

/**
 * The similarity search, mention-count aggregation, edge redirection and `supersede` close
 * all run genuine Cypher against a live server here. Vectors are hand-built rather than
 * embedded by a real model: a fixed, known cosine keeps the merge/no-merge boundary
 * deterministic, and the real embedding path is already proven by `entities.int.test.ts`. The
 * one exception is the degenerate-embedding case at the bottom, which only reproduces against
 * the real model.
 */

const DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-08-28T12:00:00.000Z');

function unitVector(index: number): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

/** Cosine against `unitVector(0)` is ~0.998 — comfortably over 0.85, comfortably under 1. */
function nearDuplicateVector(): number[] {
  const vector = unitVector(0);
  vector[1] = 0.05;
  return vector;
}

/** Cosine against `unitVector(0)` is exactly 0 — nowhere near any reasonable threshold. */
function unrelatedVector(): number[] {
  return unitVector(2);
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let episodeId: string;
let otherEpisodeId: string;

async function seedEntity(input: EntityMergeInput, vector: readonly number[]): Promise<string> {
  const [merged] = await mergeEntities(harness.driver, [input], NOW);
  if (merged === undefined) {
    throw new Error(`failed to seed entity ${input.name}`);
  }
  await writeEntityVectors(harness.driver, [{ id: merged.id, nameVector: vector }]);
  return merged.id;
}

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: 'text', session_id: 'session-1' },
  });
}

function context(): StageContext {
  return {
    driver: harness.driver,
    db,
    provider: { embed: async () => [], generate: async () => ({}) },
    episodeId,
    episode: { id: episodeId, sessionId: 'session-1', text: '', turns: [] },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-dedup-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DIMENSION });
}, 120_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('entity dedup against a live graph', () => {
  it('merges a near-duplicate into the more-mentioned identity, redirecting every edge type', async () => {
    episodeId = 'live-episode-1';
    otherEpisodeId = 'live-episode-0';
    await seedEpisode(episodeId);
    await seedEpisode(otherEpisodeId);

    const canonicalId = await seedEntity(
      {
        name: 'Aion',
        nameNorm: 'aion',
        type: 'project',
        text: 'Aion (project): the memory substrate',
        sourceEpisodeId: episodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(0),
    );
    const duplicateId = await seedEntity(
      {
        name: 'The Aion Substrate',
        nameNorm: 'the aion substrate',
        type: 'project',
        text: 'The Aion Substrate (project): a second name for the same thing',
        sourceEpisodeId: otherEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      nearDuplicateVector(),
    );

    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [canonicalId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });
    // Three mentions on the canonical-to-be against one on the duplicate, so mention count
    // alone decides which side wins.
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [canonicalId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });
    await linkEntityMentions(harness.driver, {
      episodeId: otherEpisodeId,
      entityIds: [duplicateId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toMatchObject({ merges: 1 });

    const canonical = await storedEntity(harness.driver, canonicalId);
    const duplicate = await storedEntity(harness.driver, duplicateId);
    expect(canonical?.validUntil).toBeNull();
    expect(duplicate?.validUntil).not.toBeNull();
    expect(canonical?.aliases).toEqual(['The Aion Substrate']);
    // 2 mentions on the canonical seeded it to access_count 2; the duplicate's own mention
    // added 1 more. The merge should sum both onto the surviving node.
    expect(canonical?.accessCount).toBe(3);
    // Best-effort post-commit cleanup: the closed node's vectors are gone.
    expect(duplicate?.nameVectorLength).toBe(0);

    expect(await supersedingNodeIds(harness.driver, duplicateId)).toEqual([canonicalId]);

    // PARTICIPATES_IN moved: the duplicate's episode is now claimed by the canonical too.
    expect(await participatingEpisodeIds(harness.driver, canonicalId)).toEqual(
      [episodeId, otherEpisodeId].sort(),
    );

    // MENTIONS moved too, in the opposite direction, and the old edge off the closed node survives.
    const mentionsFromOther = await mentionCounts(harness.driver, otherEpisodeId);
    expect(mentionsFromOther).toEqual(
      expect.arrayContaining([
        { id: duplicateId, count: 1 },
        { id: canonicalId, count: 1 },
      ]),
    );

    const ledgerKey = entityMergeLedgerKey(canonicalId, [duplicateId]);
    expect(getLedgerEntry(db, ledgerKey)).toBeDefined();

    const rerun = await new EntityDedupStage().run(context());
    expect(rerun.counts).toMatchObject({ merges: 0 });
    expect(await supersedingNodeIds(harness.driver, duplicateId)).toEqual([canonicalId]);
  }, 120_000);

  it('leaves an unrelated entity of the same type untouched', async () => {
    const soloEpisodeId = 'live-episode-solo';
    await seedEpisode(soloEpisodeId);

    const subjectId = await seedEntity(
      {
        name: 'Postgres',
        nameNorm: 'postgres',
        type: 'tool',
        text: 'Postgres (tool)',
        sourceEpisodeId: soloEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(0),
    );
    const unrelatedId = await seedEntity(
      {
        name: 'MySQL',
        nameNorm: 'mysql',
        type: 'tool',
        text: 'MySQL (tool)',
        sourceEpisodeId: soloEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unrelatedVector(),
    );
    await linkEntityMentions(harness.driver, {
      episodeId: soloEpisodeId,
      entityIds: [subjectId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    episodeId = soloEpisodeId;
    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.counts).toMatchObject({ merges: 0 });
    const unrelated = await storedEntity(harness.driver, unrelatedId);
    expect(unrelated?.validUntil).toBeNull();
  }, 60_000);
});

describe('what a merge has to stay merged against', () => {
  const laterEpisodeId = 'live-episode-after-merge';
  let canonicalId: string;
  let mergedAwayId: string;

  beforeAll(async () => {
    episodeId = 'live-episode-merge-holds';
    await seedEpisode(episodeId);
    await seedEpisode(laterEpisodeId);

    canonicalId = await seedEntity(
      {
        name: 'Postgres',
        nameNorm: 'postgres',
        type: 'tool',
        text: 'Postgres (tool): the relational store',
        sourceEpisodeId: episodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(0),
    );
    mergedAwayId = await seedEntity(
      {
        name: 'PostgreSQL',
        nameNorm: 'postgresql',
        type: 'tool',
        text: 'PostgreSQL (tool): the same relational store',
        sourceEpisodeId: episodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      nearDuplicateVector(),
    );
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [canonicalId, mergedAwayId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    const outcome = await new EntityDedupStage().run(context());
    expect(outcome.counts).toMatchObject({ merges: 1 });
    expect((await storedEntity(harness.driver, mergedAwayId))?.validUntil).not.toBeNull();
  }, 120_000);

  it('resolves a later episode naming the merged-away surface form onto the canonical', async () => {
    const [resolved] = await mergeEntities(
      harness.driver,
      [
        {
          name: 'PostgreSQL',
          nameNorm: 'postgresql',
          type: 'tool',
          text: 'PostgreSQL (tool): named again a week later',
          sourceEpisodeId: laterEpisodeId,
          extractionMethod: 'test',
          confidence: 0.8,
        },
      ],
      NOW,
    );

    expect(resolved?.id).toBe(canonicalId);
    expect(resolved?.created).toBe(false);

    await linkEntityMentions(harness.driver, {
      episodeId: laterEpisodeId,
      entityIds: [resolved?.id ?? ''],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    // The closed node gains nothing: the later episode's mention lands on the identity that
    // still answers, which is what keeps dedup from being undone one episode at a time.
    expect(await mentionCounts(harness.driver, laterEpisodeId)).toEqual([
      { id: canonicalId, count: 1 },
    ]);
    expect((await storedEntity(harness.driver, mergedAwayId))?.validUntil).not.toBeNull();
  }, 60_000);

  it('hands the merged-away entity to no downstream stage', async () => {
    const mentioned = await findEpisodeEntities(harness.driver, episodeId);

    expect(mentioned.map((entity) => entity.id)).toEqual([canonicalId]);
  }, 60_000);

  it('leaves the merged-away entity out of the pending-vector drain', async () => {
    const pending = await findPendingVectorNodes(harness.driver, 64);

    expect((await storedEntity(harness.driver, mergedAwayId))?.nameVectorLength).toBe(0);
    expect(pending.map((node) => node.id)).not.toContain(mergedAwayId);
  }, 60_000);
});
