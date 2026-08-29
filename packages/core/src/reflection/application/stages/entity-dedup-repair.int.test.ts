import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Dedup's harder half: what a merge must survive concurrently, the embedding model's
 * degenerate classes, and the cross-type near-duplicates it reports rather than merges.
 * The merge itself and what it has to stay merged against are `entity-dedup.int.test.ts`;
 * this file carries its own harness because an integration file owns its own container.
 */
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

describe('merge atomicity', () => {
  const atomicEpisodeId = 'live-episode-atomic';
  let survivorId: string;
  let doomedId: string;

  beforeAll(async () => {
    await seedEpisode(atomicEpisodeId);
    survivorId = await seedEntity(
      {
        name: 'Valkey',
        nameNorm: 'valkey',
        type: 'tool',
        text: 'Valkey (tool): the cache',
        sourceEpisodeId: atomicEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(0),
    );
    doomedId = await seedEntity(
      {
        name: 'Valkey Server',
        nameNorm: 'valkey server',
        type: 'tool',
        text: 'Valkey Server (tool): the same cache',
        sourceEpisodeId: atomicEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      nearDuplicateVector(),
    );
    await linkEntityMentions(harness.driver, {
      episodeId: atomicEpisodeId,
      entityIds: [survivorId, doomedId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });
  }, 120_000);

  it('closes each merged node in the transaction that moved its edges', async () => {
    const result = await redirectAndAbsorb(harness.driver, {
      canonicalId: survivorId,
      mergedIds: [doomedId],
      aliases: ['Valkey Server'],
      accessCount: 2,
      now: NOW,
    });

    expect(result.superseded).toEqual([doomedId]);
    expect(result.edgesRedirected).toBeGreaterThan(0);

    // One call, both halves: the closed node has its lineage and the canonical has its edges.
    const doomed = await storedEntity(harness.driver, doomedId);
    expect(doomed?.validUntil).not.toBeNull();
    expect(await supersedingNodeIds(harness.driver, doomedId)).toEqual([survivorId]);
    expect(await participatingEpisodeIds(harness.driver, survivorId)).toContain(atomicEpisodeId);
  }, 60_000);

  it('rolls the redirect back when any member of the group cannot be closed', async () => {
    const before = await storedEntity(harness.driver, survivorId);

    await expect(
      redirectAndAbsorb(harness.driver, {
        canonicalId: survivorId,
        mergedIds: ['an-id-no-node-answers-to'],
        aliases: ['rolled back'],
        accessCount: 99,
        now: NOW,
      }),
    ).rejects.toThrow();

    // The alias and salience write is in the same transaction as the close, so neither landed.
    const after = await storedEntity(harness.driver, survivorId);
    expect(after?.aliases).toEqual(before?.aliases);
    expect(after?.accessCount).toBe(before?.accessCount);
  }, 60_000);
});

/**
 * The exercise's own reproduction, against the real embedding model rather than hand-built
 * vectors: `nomic-embed-text` returns one constant vector for whole classes of out-of-vocabulary
 * text, so these names score 1.0000 against each other and eight distinct emoji entities were
 * closed into one node in the live product. The fold cannot fix a model that has no tokens for
 * the input; the name-form leg is what has to refuse it.
 */
describe('the degenerate embedding case', () => {
  const degenerateEpisodeId = 'live-episode-degenerate';
  let vectors: Vector[];

  function cosine(a: Vector, b: Vector): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index += 1) {
      dot += (a[index] ?? 0) * (b[index] ?? 0);
      normA += (a[index] ?? 0) ** 2;
      normB += (b[index] ?? 0) ** 2;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  beforeAll(async () => {
    const provider = new OllamaProvider({
      baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      embedModel: DEFAULTS.models.embed,
    });
    vectors = await provider.embed(['Zoë Müller', 'José Álvarez']);
    await seedEpisode(degenerateEpisodeId);
  }, 120_000);

  it('refuses two unrelated non-ASCII names the model embeds identically', async () => {
    const [subjectVector, candidateVector] = vectors;
    expect(subjectVector).toBeDefined();
    expect(candidateVector).toBeDefined();
    // The premise: still degenerate, well over the 0.85 threshold the vector leg applies.
    expect(cosine(subjectVector ?? [], candidateVector ?? [])).toBeGreaterThan(0.85);

    const subjectId = await seedEntity(
      {
        name: 'Zoë Müller',
        nameNorm: 'zoë müller',
        type: 'person',
        text: 'Zoë Müller (person)',
        sourceEpisodeId: degenerateEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      subjectVector ?? [],
    );
    const otherId = await seedEntity(
      {
        name: 'José Álvarez',
        nameNorm: 'josé álvarez',
        type: 'person',
        text: 'José Álvarez (person)',
        sourceEpisodeId: degenerateEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      candidateVector ?? [],
    );
    await linkEntityMentions(harness.driver, {
      episodeId: degenerateEpisodeId,
      entityIds: [subjectId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    episodeId = degenerateEpisodeId;
    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.counts).toMatchObject({ merges: 0, cross_type_proposals: 0 });
    expect((await storedEntity(harness.driver, subjectId))?.validUntil).toBeNull();
    expect((await storedEntity(harness.driver, otherId))?.validUntil).toBeNull();
    expect(listEntityMergeProposals(db)).toEqual([]);
  }, 120_000);
});

describe('cross-type near-duplicates', () => {
  const crossTypeEpisodeId = 'live-episode-cross-type';

  it('proposes the pair the type key made unmergeable, and merges nothing', async () => {
    await seedEpisode(crossTypeEpisodeId);
    const toolId = await seedEntity(
      {
        name: 'Kubernetes',
        nameNorm: 'kubernetes',
        type: 'tool',
        text: 'Kubernetes (tool): the orchestrator',
        sourceEpisodeId: crossTypeEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(0),
    );
    const conceptId = await seedEntity(
      {
        name: 'Kubernetes',
        nameNorm: 'kubernetes',
        type: 'concept',
        text: 'Kubernetes (concept): the orchestrator',
        sourceEpisodeId: crossTypeEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      nearDuplicateVector(),
    );
    await linkEntityMentions(harness.driver, {
      episodeId: crossTypeEpisodeId,
      entityIds: [toolId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    episodeId = crossTypeEpisodeId;
    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.counts).toMatchObject({ merges: 0, cross_type_proposals: 1 });
    expect((await storedEntity(harness.driver, toolId))?.validUntil).toBeNull();
    expect((await storedEntity(harness.driver, conceptId))?.validUntil).toBeNull();

    const proposals = listEntityMergeProposals(db).filter(
      (proposal) => proposal.episodeId === crossTypeEpisodeId,
    );
    expect(proposals).toHaveLength(1);
    expect([proposals[0]?.leftType, proposals[0]?.rightType].sort()).toEqual(['concept', 'tool']);
    expect(proposals[0]?.resolvedAt).toBeNull();
  }, 120_000);
});
