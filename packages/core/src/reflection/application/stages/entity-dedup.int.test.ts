import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityDedupStage } from './entity-dedup.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import {
  loadEntityDedupDetails,
  type DedupEntityDetail,
} from '../../../infrastructure/graph/entity-dedup-queries.js';
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
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { entityMergeLedgerKey } from '../../domain/entity-merge.js';
import type { StageContext } from '../../domain/stage.js';
import {
  judgedNames,
  refusingEntityJudge,
  scriptedEntityJudge,
  type ScriptedEntityJudge,
} from '../entity-merge-judge.fixture.js';
import { collectMergeSignals } from '../entity-merge-writer.js';

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

/** Cosine against `unitVector(0)` is ~0.998: comfortably over 0.85, comfortably under 1. */
function nearDuplicateVector(): number[] {
  const vector = unitVector(0);
  vector[1] = 0.05;
  return vector;
}

/** Cosine against `unitVector(0)` is exactly 0: nowhere near any reasonable threshold. */
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

/**
 * Tier 3 decides every pair here, so the run needs a judge. It is scripted rather than live:
 * what these cases prove is the Cypher (the search, the redirect, the close), and a real model
 * would make the merge boundary a measurement of the model instead.
 */
function context(judge: ScriptedEntityJudge = scriptedEntityJudge()): StageContext {
  return {
    driver: harness.driver,
    db,
    provider: { embed: async () => [], generate: judge.generate },
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
    const thirdEpisodeId = 'live-episode-2';
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
    // Two episodes name the canonical-to-be against one naming the duplicate, so the
    // distinct-episode count alone decides which side wins.
    await seedEpisode(thirdEpisodeId);
    await linkEntityMentions(harness.driver, {
      episodeId: thirdEpisodeId,
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
      [episodeId, thirdEpisodeId, otherEpisodeId].sort(),
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
    const judge = refusingEntityJudge();
    const outcome = await new EntityDedupStage().run(context(judge));

    expect(outcome.counts).toMatchObject({ merges: 0 });
    // The unrelated name is never even a pair: its vector is nowhere near the subject's, so no
    // nominator puts it forward and no model call is spent deciding about it.
    expect(judge.calls.flatMap(judgedNames)).not.toContain('MySQL');
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

    // The judge answers for this pair alone. Every entity in this database carries a
    // hand-built vector, so a blanket yes would merge the whole file's cast into one node.
    const pairOnly = scriptedEntityJudge({
      same: (left, right) =>
        [left, right].every((name) => name.toLowerCase().startsWith('postgre')),
      review: (left, right) =>
        [left, right].every((name) => name.toLowerCase().startsWith('postgre')),
    });
    const outcome = await new EntityDedupStage().run(context(pairOnly));
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

/**
 * The record is the artifact that makes a merge arguable later, so what it says about a signal
 * nobody could take has to be "nobody took it". A concurrent reflection can absorb a member
 * between the tier that nominated the pair and the read that measures it, and the pair read
 * then returns no row at all.
 */
describe('what a decision record says about evidence nobody could measure', () => {
  it('leaves the graph signals absent when the pair read returns no row', async () => {
    const canonicalId = await seedEntity(
      {
        name: 'Signal Canonical',
        nameNorm: 'signal canonical',
        type: 'tool',
        text: 'Signal Canonical (tool)',
        sourceEpisodeId: episodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(4),
    );
    const [canonical] = await loadEntityDedupDetails(harness.driver, [canonicalId]);
    if (canonical === undefined) {
      throw new Error('failed to load the canonical detail');
    }
    const absorbedElsewhere: DedupEntityDetail = {
      ...canonical,
      id: 'absorbed-before-the-read',
      name: 'Signal Member',
      nameNorm: 'signal member',
    };

    const [signals] = await collectMergeSignals(harness.driver, canonical, [
      canonical,
      absorbedElsewhere,
    ]);

    expect(signals?.memberId).toBe('absorbed-before-the-read');
    expect(signals).not.toHaveProperty('sharedEpisodeCount');
    expect(signals).not.toHaveProperty('sharedEpisodeJaccard');
    expect(signals).not.toHaveProperty('neighborOverlapCount');
    expect(signals).not.toHaveProperty('neighborOverlapJaccard');
    expect(signals?.nameFormRelation).toBe('none');
  }, 60_000);

  it('keeps a measured zero, which is a different statement', async () => {
    const leftId = await seedEntity(
      {
        name: 'Measured Left',
        nameNorm: 'measured left',
        type: 'tool',
        text: 'Measured Left (tool)',
        sourceEpisodeId: episodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(5),
    );
    const rightId = await seedEntity(
      {
        name: 'Measured Right',
        nameNorm: 'measured right',
        type: 'tool',
        text: 'Measured Right (tool)',
        sourceEpisodeId: episodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(6),
    );
    const details = await loadEntityDedupDetails(harness.driver, [leftId, rightId]);
    const left = details.find((detail) => detail.id === leftId);
    const right = details.find((detail) => detail.id === rightId);
    if (left === undefined || right === undefined) {
      throw new Error('failed to load both details');
    }

    const [signals] = await collectMergeSignals(harness.driver, left, [left, right]);

    expect(signals?.sharedEpisodeCount).toBe(0);
    expect(signals?.neighborOverlapJaccard).toBe(0);
  }, 60_000);
});
