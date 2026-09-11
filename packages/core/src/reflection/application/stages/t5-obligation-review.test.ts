import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DedupFakeGraph } from './entity-dedup.fixture.js';
import { EntityDedupStage } from './entity-dedup.js';
import type { JudgmentEvidence } from '../../../evidence/application/judgment.js';
import { ACCESS_COUNT_PROPERTY } from '../../../infrastructure/graph/access-tracking.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { ENTITY_ALIASES_PROPERTY } from '../../../infrastructure/graph/entity-identity-queries.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_MENTION_TYPE,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
  ENTITY_PARTICIPATION_TYPE,
  ENTITY_TYPE_COUNTS_PROPERTY,
} from '../../../infrastructure/graph/entity-queries.js';
import type { EpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { SUPERSEDES_TYPE } from '../../../infrastructure/graph/relationships.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  STRUCTURAL_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { squashName } from '../../domain/entity-reconciliation.js';
import { foldName } from '../../domain/name-fold.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import {
  scriptedEntityJudge as scriptedJudge,
  unreachableEntityJudge as unreachableProvider,
  type ScriptedEntityJudge,
} from '../entity-merge-judge.fixture.js';

const EPISODE_ID = 'episode-1';
const SESSION_ID = 'session-1';
const OTHER_EPISODE_ID = 'episode-0';
const THIRD_EPISODE_ID = 'episode-2';
const NOW = new Date('2026-08-28T09:05:00.000Z');
const OLDER = new Date('2026-01-01T00:00:00.000Z');
const NEWER = new Date('2026-06-01T00:00:00.000Z');

let graph: DedupFakeGraph;
let store: SqliteStore;
let dataDir: string;

function episode(): EpisodeContext {
  return { id: EPISODE_ID, sessionId: SESSION_ID, text: '', turns: [] };
}

function context(judge: ScriptedEntityJudge = scriptedJudge()): StageContext {
  return {
    driver: graph.driver,
    db: store.db,
    provider: {
      embed: async () => [],
      generate: judge.generate,
    },
    episodeId: EPISODE_ID,
    episode: episode(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
}

type EntitySeed = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly vector: readonly number[];
  readonly txFrom?: Date;
  readonly structural?: boolean;
  readonly accessCount?: number;
  readonly aliases?: readonly string[];
  readonly superseded?: boolean;
  readonly nameVectorHash?: string;
  readonly typeCounts?: string;
  readonly description?: string;
};

function seedEntity(seed: EntitySeed): void {
  const nameNorm = foldName(seed.name);
  graph.seedNode(seed.id, ['Entity', 'Memory', 'AionNode'], {
    [ENTITY_NAME_PROPERTY]: seed.name,
    [ENTITY_NAME_NORM_PROPERTY]: nameNorm,
    [ENTITY_NAME_SQUASH_PROPERTY]: squashName(nameNorm),
    type: seed.type,
    [ENTITY_NAME_VECTOR_PROPERTY]: [...seed.vector],
    [BITEMPORAL_PROPERTIES.txFrom]: seed.txFrom ?? OLDER,
    ...(seed.structural === true ? { [STRUCTURAL_PROPERTY]: true } : {}),
    ...(seed.accessCount === undefined ? {} : { [ACCESS_COUNT_PROPERTY]: seed.accessCount }),
    ...(seed.aliases === undefined
      ? {}
      : {
          [ENTITY_ALIASES_PROPERTY]: [...seed.aliases],
          [ENTITY_ALIASES_NORM_PROPERTY]: seed.aliases.map((alias) => foldName(alias)),
        }),
    ...(seed.superseded === true ? { [BITEMPORAL_PROPERTIES.validUntil]: OLDER } : {}),
    ...(seed.nameVectorHash === undefined
      ? {}
      : { [ENTITY_NAME_VECTOR_HASH_PROPERTY]: seed.nameVectorHash }),
    ...(seed.typeCounts === undefined ? {} : { [ENTITY_TYPE_COUNTS_PROPERTY]: seed.typeCounts }),
    ...(seed.description === undefined ? {} : { [MEMORY_PROPERTIES.text]: seed.description }),
  });
}

function seedEpisode(id: string): void {
  graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: 'text',
    [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
  });
}

function mention(episodeId: string, entityId: string, count = 1): void {
  graph.seedEdge(ENTITY_MENTION_TYPE, episodeId, entityId);
  const edge = graph
    .edgesOfType(ENTITY_MENTION_TYPE)
    .find((candidate) => candidate.sourceId === episodeId && candidate.targetId === entityId);
  if (edge !== undefined) {
    edge.count = count;
  }
  graph.seedEdge(ENTITY_PARTICIPATION_TYPE, entityId, episodeId);
}

beforeEach(() => {
  graph = new DedupFakeGraph();
  seedEpisode(EPISODE_ID);
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-dedup-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** The canonical-to-be seen in two episodes against a duplicate seen in one. */
function seedNearDuplicatePair(): void {
  seedEntity({
    id: 'strong',
    name: 'Aion',
    type: 'project',
    vector: [1, 0],
    txFrom: NEWER,
    accessCount: 3,
  });
  seedEntity({
    id: 'weak',
    name: 'Aion Project',
    type: 'project',
    vector: [9, 4],
    txFrom: OLDER,
    accessCount: 1,
  });
  seedEpisode(OTHER_EPISODE_ID);
  seedEpisode(THIRD_EPISODE_ID);
  mention(EPISODE_ID, 'strong', 3);
  mention(THIRD_EPISODE_ID, 'strong', 1);
  mention(OTHER_EPISODE_ID, 'weak', 1);
}

/** A seam that abstains on every pair, which is what a suppressed required source produces. */
function abstaining(): JudgmentEvidence {
  return {
    assemble: () =>
      Promise.resolve({
        status: 'abstained',
        reason: 'required_source_suppressed',
        addresses: [{ kind: 'id', id: OTHER_EPISODE_ID }],
        revision: { contractVersion: 1, dependencies: [], digest: 'digest' },
      }),
    confirm: () => ({ status: 'current' }),
  };
}

describe('tier 3 with an evidence seam', () => {
  it('asks nobody about a pair whose required source is suppressed', async () => {
    seedNearDuplicatePair();

    const outcome = await new EntityDedupStage().run({
      ...context(unreachableProvider()),
      evidence: abstaining(),
    });

    expect(outcome.counts).toMatchObject({ merges: 0, merge_judgments: 0, merge_withheld: 1 });
    expect(outcome.retryable === true || outcome.status === 'failed').toBe(true);
    expect(graph.edgesOfType(SUPERSEDES_TYPE)).toEqual([]);
  });
});
